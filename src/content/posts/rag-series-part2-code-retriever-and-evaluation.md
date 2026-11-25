---
title: "RAG 파이프라인 2편(실습): 하이브리드 검색기 구현과 정밀도, 재현율 평가"
description: "뉴스 데이터와 임베딩으로 BM25 역색인, 코사인 유사도, 역순위 융합(RRF) 하이브리드 검색을 구현하고, 20 Newsgroups 데이터셋으로 정밀도와 재현율을 평가한다."
pubDate: "2026-10-28 08:20:00"
tags: ["RAG", "BM25", "CosineSimilarity", "RRF", "Evaluation", "Python"]
categories: ["Architecture", "AI"]
draft: false
---

## 1. 검색 데이터와 임베딩

사전 학습된 대규모 언어 모델(LLM)은 학습 시점 이후에 발생한 최신 사건이나 사내 비공개 문서를 알지 못한다. 예를 들어 모델에게 2024년의 최신 경제 지표(GDP)나 스포츠 경기 결과를 물어보면 답변을 거부하거나 부정확한 정보를 생성한다.

이 문제를 해결하려면 외부 뉴스 데이터베이스에서 질문과 관련된 기사를 찾아 프롬프트에 참고 자료로 넣어주는 검색기가 필요하다. 이번 글에서는 2편 이론에서 다룬 **키워드 검색(BM25)**, **시맨틱 검색(코사인 유사도)**, **역순위 융합(RRF)**을 파이썬 코드로 구현해 하이브리드 RAG 파이프라인을 완성한다. 이어서 검색기가 얼마나 정확한 문서를 찾는지 **정밀도($\text{Precision@}K$)**와 **재현율($\text{Recall@}K$)**로 자동 채점하는 평가 루프까지 조립한다.

가장 먼저 검색 대상이 될 뉴스 기사 데이터를 메모리에 불러오고 구조를 확인한다. *(실습 환경의 `read_dataframe` 헬퍼는 CSV를 읽어 딕셔너리 리스트를 반환하며, 표준 `pandas.read_csv("news_data_dedup.csv").to_dict("records")`와 같은 역할을 한다.)*

```python
from utils import read_dataframe

NEWS_DATA = read_dataframe("news_data_dedup.csv")

# 첫 번째 뉴스 기사의 데이터 구조 확인
print(NEWS_DATA[0])
```

```python
{
    'guid': 'e2223829839c11303f8c279207b8a832',
    'title': 'Global growth forecasts hold steady amid easing inflation',
    'description': 'Central bank economists point to resilient consumer demand across major economies...',
    'venue': 'Reuters Business',
    'published_at': '2024-05-04 12:36:56+00:00',
    'url': 'https://www.example.com/business/global-growth-2024',
    'full_text': '...'
}
```

각 기사는 고유 식별자(`guid`), 제목(`title`), 본문 요약(`description`), 언론사(`venue`), 발행일(`published_at`), 링크(`url`) 등의 키를 가진 딕셔너리다.

이제 기사 위치 번호(Index) 리스트를 넘기면 해당 기사 딕셔너리들만 꺼내 반환하는 조회 함수 `query_news`를 작성한다. 검색 함수들은 무거운 본문 전체 대신 **문서 위치 번호(`list[int]`)**만 반환하게 설계하고, 마지막에 `query_news`로 원문을 조회한다.

```python
def query_news(indices: list[int]) -> list[dict]:
    """지정된 인덱스 리스트에 해당하는 뉴스 기사 딕셔너리 목록을 반환한다."""
    # 검색 함수가 반환한 정수 위치 번호 순서대로 원본 리스트에서 기사 추출
    output = [NEWS_DATA[index] for index in indices]
    return output
```

다음으로 시맨틱 검색에서 쓸 임베딩 모델과 뉴스 기사 사전 계산 임베딩 파일(`news_embeddings.joblib`)을 불러온다. *(5장의 20 Newsgroups 평가에서는 별도 임베딩 파일인 `newsgroups_embeddings.joblib`을 구분해 사용한다.)*

```python
import os
import joblib
from sentence_transformers import SentenceTransformer

# 로컬과 서버 환경이 달라도 동작하도록 환경 변수(MODEL_PATH)로 기본 경로 지정
model_name = os.path.join(os.environ.get("MODEL_PATH", "./models"), "BAAI/bge-base-en-v1.5")
model = SentenceTransformer(model_name)

EMBEDDINGS = joblib.load("news_embeddings.joblib")
```

이 코드는 실시간 응답 속도를 확보하기 위해 **오프라인 사전 색인**과 **온라인 질문 인코딩**을 나눈 구성이다. 수천 건의 뉴스 기사를 요청마다 인코딩하면 수 분씩 걸리므로, 뉴스 본문은 미리 `news_embeddings.joblib`에 저장해 두고 시작 시 메모리에 올린다. `model` 객체는 사용자가 실시간으로 입력하는 질문 문장 단 1개를 768차원 벡터로 바꿀 때만 호출한다.

---

## 2. BM25와 역색인 검색

### 역색인 사전 구축

원본 데이터(`NEWS_DATA`)가 준비되었으므로 첫 번째 검색기인 키워드 기반 BM25 검색 함수를 만든다. 수천 건 뉴스를 매번 처음부터 읽지 않으려면, 먼저 어떤 단어가 몇 번 뉴스에 몇 번 나오는지 정리한 **역색인(Inverted Index) 사전**을 만들어 두어야 한다.

```python
import bm25s

# 1. 검색 대상으로 쓸 '제목 + 요약' 문자열 코퍼스 생성
corpus = [x['title'] + " " + x['description'] for x in NEWS_DATA]

# 2. 검색기 내부에 원본 코퍼스를 등록하고 불용어 제거 및 토큰화 후 역색인 구축
BM25_RETRIEVER = bm25s.BM25(corpus=corpus)
TOKENIZED_DATA = bm25s.tokenize(corpus)
BM25_RETRIEVER.index(TOKENIZED_DATA)
```

이 네 줄은 먼저 ① 제목과 요약을 공백으로 묶은 `corpus`를 만들고, ② `bm25s.BM25(corpus=corpus)`로 원본 텍스트를 연결한 검색기를 생성한다. 이어서 ③ 불용어를 거른 단어 토큰 집합으로 쪼개고(`.tokenize`), ④ 단어별 TF/IDF와 문서 길이를 역색인 사전에 등록(`.index`)한다.

### `bm25_retrieve` 함수 작성과 차원 추적

역색인 사전(`BM25_RETRIEVER`)이 구축되었으므로, 질문(`query`)과 반환 개수(`top_k`)를 받아 상위 문서 위치 번호(`list[int]`)를 반환하는 `bm25_retrieve` 함수를 구현한다.

```python
def bm25_retrieve(query: str, top_k: int = 5) -> list[int]:
    """BM25 알고리즘으로 질문과 관련성이 높은 상위 K개 문서 인덱스를 반환한다."""
    # 1. 역색인 구축 시와 동일한 규칙으로 질문 문장을 불용어 제거 후 토큰화
    tokenized_query = bm25s.tokenize(query)

    # 2. 두 번째 위치 인자가 corpus이므로 반드시 k=top_k 키워드 인자로 명시해 호출
    #    bm25s는 배치 처리용으로 (질문 수 x top_k) 2차원 배열을 반환하므로 results[0]으로 첫 질문 목록만 꺼냄
    results, scores = BM25_RETRIEVER.retrieve(tokenized_query, k=top_k)
    results = results[0]

    # 3. corpus=corpus 옵션 때문에 문자열이 반환되므로 원본 리스트 내 정수 인덱스로 역추적
    top_k_indices = [corpus.index(doc) for doc in results]
    return top_k_indices
```

실제 예시 `"What are the recent news about GDP?"`(`top_k=5`)를 넣었을 때 `results`와 `top_k_indices`가 어떻게 변환되는지 살펴본다.
- **토큰화와 검색**: `bm25s.tokenize(query)`는 `'what'`, `'are'` 같은 불용어를 제외하고 `[['recent', 'news', 'gdp']]` 핵심 키워드만 남긴다. 이어 `retrieve(tokenized_query, k=top_k)`를 부를 때 `k=` 키워드를 빼먹으면 두 번째 위치 인자(`corpus`)에 숫자가 들어가 오류가 나므로 주의한다.
- **2차원 배치 결과 해제 (`results[0]`)**: `bm25s`는 여러 질문을 한꺼번에 처리(Batch)하도록 설계되어 있어 질문을 1개만 넘겨도 바깥 대괄호가 한 겹 더 씌워진 `[["752번 본문...", ...]]` 형태가 나온다. 따라서 `results = results[0]`으로 안쪽 1차원 문자열 리스트를 꺼낸다.
- **문자열에서 위치 번호 복원 (`corpus.index(doc)`)**: 검색기 초기화 시 `corpus=corpus`를 넘겼기 때문에 결과에 인덱스가 아니라 기사 문자열 자체가 담긴다. 반환 타입을 `list[int]`로 맞추기 위해 원본 `corpus`에서 각 본문 위치 번호를 찾아 돌려준다.

작성한 함수를 실행하고 1절의 `query_news`로 1위 기사를 확인한다.

```python
bm25_indices = bm25_retrieve("What are the recent news about GDP?")
print("BM25 Top-5 Indices:", bm25_indices)
# 출력: BM25 Top-5 Indices: [752, 673, 289, 626, 43]

top_bm25_news = query_news([bm25_indices[0]])
print("1위 뉴스 제목:", top_bm25_news[0]['title'])
# 출력: 1위 뉴스 제목: US GDP growth cools slightly in Q1 as consumer spending adjusts
```

---

## 3. 코사인 유사도 검색

### 문장 임베딩 생성과 코사인 유사도 함수

두 번째로 만들 검색기는 질문과 단어가 정확히 일치하지 않아도 문맥의 의미가 유사한 기사를 찾아내는 시맨틱 검색기다.

1절에서 불러온 임베딩 모델 `model`(`BAAI/bge-base-en-v1.5`)에 문장을 넣고 `model.encode(query)`를 실행하면, 모델 내부에서는 세 단계 연산이 일어난다.
1. 문장을 서브워드(Sub-word) 단위의 토큰 ID로 잘게 쪼갠다.
2. 12개의 트랜스포머 어텐션 레이어를 통과시키며 문장 내 단어들 사이의 문맥 관계를 계산한다.
3. 각 단어 위치에서 나온 출력 벡터들을 평균 내는 풀링(Mean Pooling)을 거쳐 길이 768의 1차원 실수 벡터(`(768,)`) 하나를 출력한다.

```python
sample_emb = model.encode("What are the recent news about GDP?")
print("임베딩 벡터 모양:", sample_emb.shape)
print("앞 5개 실수 값:", sample_emb[:5])
# 출력:
# 임베딩 벡터 모양: (768,)
# 앞 5개 실수 값: [-0.0124, 0.0341, -0.0089, ...]
```

이제 질문 벡터 `v1`과 문서 벡터 묶음 `array_of_vectors`를 받는다. 두 입력 사이의 코사인 유사도($\frac{v_1 \cdot v_2}{\lVert v_1 \rVert \lVert v_2 \rVert}$)를 계산하는 `cosine_similarity` 함수를 구현한다.

```python
import numpy as np


def cosine_similarity(v1, array_of_vectors):
    """질문 벡터 v1과 문서 벡터 배열 사이의 코사인 유사도 NumPy 배열을 반환한다."""
    # 1. 입력 벡터를 NumPy 배열로 맞추고 유사도 결과를 담을 리스트 초기화
    v1 = np.array(v1)
    similarities = []

    # 2. 문서 1건짜리 1차원 벡터만 들어와도 아래 반복문이 원소별로 깨지지 않게 2차원 리스트로 감쌈
    if len(np.shape(array_of_vectors)) == 1:
        array_of_vectors = [array_of_vectors]

    # 3. 각 문서 벡터와의 내적(분자)을 두 벡터 크기 곱(분모)으로 나누어 방향 유사도 계산
    for v2 in array_of_vectors:
        v2 = np.array(v2)
        dot_product = np.dot(v1, v2)
        norm_v1 = np.linalg.norm(v1)
        norm_v2 = np.linalg.norm(v2)
        similarity = dot_product / (norm_v1 * norm_v2)
        similarities.append(similarity)

    return np.array(similarities)
```

이 함수에서 두 벡터의 크기 곱으로 내적을 나누면 문서 길이 차이를 없앤 순수 방향 유사도($-1.0 \sim 1.0$)를 얻을 수 있다. 단일 벡터 1개를 넣었더라도 `array([0.724])` 형태의 NumPy 1차원 배열을 반환하므로, 값 하나만 꺼낼 때는 `[0]`을 붙인다.

### `semantic_search_retrieve` 구현과 부호 반전 정렬

위 `cosine_similarity` 함수와 뉴스 벡터 `EMBEDDINGS`를 사용해 상위 $K$개 문서 번호를 찾는 `semantic_search_retrieve` 함수를 작성한다.

```python
def semantic_search_retrieve(query: str, top_k: int = 5) -> list[int]:
    """질문 임베딩과 사전 계산된 문서 벡터의 코사인 유사도를 비교해 상위 K개 문서 인덱스를 반환한다."""
    # 1. 실시간 사용자 질문 문장을 768차원 벡터로 변환
    query_embedding = model.encode(query)

    # 2. 전체 문서 임베딩과 코사인 유사도 계산 (1차원 NumPy 배열 반환)
    similarity_scores = cosine_similarity(query_embedding, EMBEDDINGS)

    # 3. np.argsort()는 오름차순만 지원하므로 - 부호로 유사도를 뒤집어 내림차순 인덱스를 추출
    similarity_indices = np.argsort(-similarity_scores)
    top_k_indices_array = similarity_indices[0:top_k]

    # 4. np.int64 원소를 파이썬 기본 int로 변환해 bm25_retrieve()와 반환 타입(list[int]) 통일
    top_k_indices = [int(x) for x in top_k_indices_array]
    return top_k_indices
```

`np.sort(similarity_scores)`는 점수만 정렬하고 어느 문서인지 잃어버리는 반면, `np.argsort`는 **각 순위 자리에 들어갈 원래 문서 번호**를 돌려준다. 이때 `np.argsort`는 작은 값부터 정렬하는 오름차순만 지원하므로 점수 앞에 마이너스(`-`)를 붙여 큰 점수가 음수의 최솟값이 되도록 뒤집는다. 예를 들어 `[0.2, 0.9, 0.5]`에 `-`를 붙이면 `[-0.2, -0.9, -0.5]`가 되므로, `np.argsort` 결과 맨 앞에 `-0.9`에 해당하는 1번 문서(`[1, 2, 0]`)가 온다.

동일한 질문으로 시맨틱 검색 결과를 확인한다.

```python
semantic_indices = semantic_search_retrieve("What are the recent news about GDP?")
print("Semantic Top-5 Indices:", semantic_indices)
# 출력: Semantic Top-5 Indices: [743, 673, 626, 752, 326]

top_semantic_news = query_news([semantic_indices[0]])
print("1위 뉴스 제목:", top_semantic_news[0]['title'])
# 출력: 1위 뉴스 제목: IMF raises global economic growth outlook for 2024
```

2절의 BM25 결과(`[752, 673, 289, 626, 43]`)와 비교하면 `673`, `626`, `752`번 기사는 두 검색기 모두 상위에 뽑았다. 반면 시맨틱 검색기는 `"GDP"`라는 단어가 직접 덜 등장해도 세계 경제 성장 전망 문맥을 다룬 `743`번 기사를 1위로 찾아냈다.

---

## 4. RRF 병합과 프롬프트

### `reciprocal_rank_fusion` 구현과 병합 확인

두 검색기의 장점을 결합하려면 양쪽 순위 리스트(`list1`, `list2`)를 하나로 합쳐야 한다. 두 검색기는 점수 단위가 달라 점수를 그대로 더할 수 없다. 따라서 각 순위를 $\frac{1}{\text{rank} + K}$ 공식으로 환산해 합산하는 **역순위 융합(RRF)** 함수를 구현한다.

```python
def reciprocal_rank_fusion(list1: list[int], list2: list[int], top_k: int = 5, K: int = 60) -> list[int]:
    """서로 다른 두 순위 리스트를 역순위 융합(RRF) 점수로 결합해 상위 K개 문서 인덱스를 반환한다."""
    rrf_scores = dict()

    for lst in [list1, list2]:
        # 1. 검색 순위는 1등부터 시작해야 수식이 성립하므로 enumerate(..., start=1) 사용
        for rank, item in enumerate(lst, start=1):
            # 처음 등장한 문서 번호는 0점으로 초기화한 뒤 순위 점수를 누적한다
            if item not in rrf_scores:
                rrf_scores[item] = 0
            # 2. 각 문서에 1 / (rank + K) 역순위 점수를 누적 (양쪽 리스트에 모두 있으면 합산됨)
            rrf_scores[item] += 1 / (rank + K)

    # 3. 딕셔너리 키(문서 번호)가 아니라 RRF 점수(.get) 기준으로 내림차순 정렬 후 상위 top_k개 추출
    sorted_items = sorted(rrf_scores, key=rrf_scores.get, reverse=True)
    top_k_indices = [int(x) for x in sorted_items[0:top_k]]
    return top_k_indices
```

파이썬 `sorted(rrf_scores)`만 호출하면 문서 번호 크기순으로 정렬되므로, 반드시 `key=rrf_scores.get, reverse=True`를 지정해 RRF 점수가 큰 순서로 정렬해야 한다. 앞서 얻은 시맨틱 검색과 BM25 결과를 병합해 본다.

```python
# list1(시맨틱): [743, 673, 626, 752, 326]
# list2(BM25):   [752, 673, 289, 626, 43]
rrf_indices = reciprocal_rank_fusion(semantic_indices, bm25_indices, top_k=5)
print("RRF Top-5 Indices:", rrf_indices)
# 출력: RRF Top-5 Indices: [673, 752, 626, 743, 289]
```

결과를 보면 시맨틱 검색과 BM25 양쪽에서 모두 2등을 차지해 점수가 두 번 누적된 `673`번 기사가 단독 1위였던 `743`번과 `752`번을 앞질러 최종 1위로 올라섰다.

### 최종 프롬프트 조립 (`generate_final_prompt`)과 LLM 연결

이제 세 검색 함수(`bm25_retrieve`, `semantic_search_retrieve`, `reciprocal_rank_fusion`)를 인자로 받아 증강 프롬프트를 완성하는 `generate_final_prompt` 함수를 조립한다.

```python
from typing import Callable

def generate_final_prompt(
    query: str,
    top_k: int,
    retrieve_function: Callable | None = None,
    use_rag: bool = True,
) -> str:
    """선택한 검색기로 상위 K개 뉴스를 조회한 뒤 질문과 합쳐 증강 프롬프트를 생성한다."""
    prompt = query
    # 1. RAG 비활성화 모드(use_rag=False)면 검색 없이 원본 질문만 반환
    if not use_rag:
        return prompt

    # 검색기 인자가 비어 있으면 기본 하이브리드 RRF 병합 함수를 사용해 AttributeError를 막는다
    if retrieve_function is None:
        retrieve_function = reciprocal_rank_fusion

    # 2. 넘겨받은 검색 함수 이름(__name__)에 따라 하이브리드 RRF 분기 또는 단일 검색기 실행
    if retrieve_function.__name__ == 'reciprocal_rank_fusion':
        list1 = semantic_search_retrieve(query=query, top_k=top_k)
        list2 = bm25_retrieve(query=query, top_k=top_k)
        top_k_indices = retrieve_function(list1, list2, top_k=top_k)
    else:
        top_k_indices = retrieve_function(query=query, top_k=top_k)

    # 3. 조회한 기사들의 제목, 요약, 발행일, 출처 URL을 줄바꿈 텍스트로 정리
    relevant_documents = query_news(top_k_indices)
    formatted_documents = [
        (
            f"Title: {doc['title']}, Description: {doc['description']}, "
            f"Published at: {doc['published_at']}\nURL: {doc['url']}"
        )
        for doc in relevant_documents
    ]
    retrieve_data_formatted = "\n".join(formatted_documents)

    # 4. 2024년 참고 문맥과 사용자 질문을 결합해 반환
    prompt = (
        f"Answer the user query below. There will be provided additional information for you to compose your answer. "
        f"The relevant information provided is from 2024 and it should be added as your overall knowledge to answer the query, "
        f"you should not rely only on this information to answer the query, but add it to your overall knowledge."
        f"\nQuery: {query}\n"
        f"2024 News: {retrieve_data_formatted}"
    )
    return prompt
```

이 함수는 파이썬에서 함수 객체 자체를 인자(`retrieve_function: Callable`)로 받고 `.__name__` 속성으로 RRF 병합 여부를 분기한다. 추출한 기사 5건은 각각 제목, 요약, 발행일, URL 문자열로 정리한 뒤 `"\n".join(...)`으로 묶어 질문 아래에 붙인다.

완성된 프롬프트를 언어 모델 호출 래퍼 함수 `llm_call`(내부적으로 OpenAI 호환 API 클라이언트를 호출해 답변 텍스트를 반환하는 유틸리티)에 전달하면 전체 RAG 응답이 생성된다.

```python
from utils import llm_call

user_query = "What are the recent news about GDP?"

augmented_prompt = generate_final_prompt(
    query=user_query,
    top_k=5,
    retrieve_function=reciprocal_rank_fusion,
    use_rag=True
)

response = llm_call(augmented_prompt)
print(response)
```

```text
Recent 2024 economic reports highlight that while US GDP growth cooled modestly in the first quarter as consumer demand normalized, the IMF upgraded its global economic growth forecast citing resilient service sector activity across major economies.
```

---

## 5. 정밀도와 재현율 평가

### 평가용 20 Newsgroups 데이터셋과 판다스 표 구성

앞선 뉴스 데이터(`news_data_dedup.csv`)에는 각 기사의 정답 주제 라벨이 없어 검색 정확도를 자동 채점할 수 없다. 정밀도($\text{Precision@}K$)와 재현율($\text{Recall@}K$)을 정량 평가하기 위한 벤치마크가 필요하다. 이를 위해 모든 문서에 20개 주제 중 하나의 정답 번호가 붙어 있는 **20 Newsgroups 데이터셋**(11,314건)을 불러온다.

```python
from sklearn.datasets import fetch_20newsgroups
import pandas as pd

newsgroups_train = fetch_20newsgroups(
    subset='train',
    shuffle=True,
    random_state=42,
    data_home='./dataset'
)

df = pd.DataFrame({
    'text': newsgroups_train.data,
    'category': newsgroups_train.target
})

print("Data shape:", df.shape)
# 출력: Data shape: (11314, 2)
```

`random_state=42`로 섞인 순서를 고정하고 `data_home='./dataset'`에 내려받으면 매번 같은 순서로 11,314개 행을 재현할 수 있다. `0`부터 `19`까지의 카테고리 번호가 가리키는 실제 주제 이름(`'sci.space'`, `'sci.med'` 등)은 `newsgroups_train.target_names`에 들어 있다. 이렇게 각 문서 옆에 카테고리 번호를 붙여 두면, 평가 질문마다 기대하는 정답 주제(`desired_category`)를 지정해 두고 검색 결과가 해당 주제인지 자동으로 비교할 수 있다.

이제 20 Newsgroups 11,314건을 임베딩해 둔 파일(`newsgroups_embeddings.joblib`)과 임베딩 모델을 환경 변수 `MODEL_PATH` 기준으로 불러온다.

```python
import os
import joblib
from sentence_transformers import SentenceTransformer

model_dir = os.environ.get("MODEL_PATH", "./models")
model_name = os.path.join(model_dir, "BAAI/bge-base-en-v1.5")
model = SentenceTransformer(model_name)

# 1절의 news_embeddings.joblib과 마찬가지로 현재 작업 디렉터리의 사전 계산 임베딩 파일을 불러온다
embeddings = joblib.load("newsgroups_embeddings.joblib")
```

### 행렬 곱을 활용한 `cosine_similarity_batch` 개선

본격적인 평가에 앞서 3절의 `cosine_similarity`를 대규모 평가용으로 확장한다. 문서가 11,314건으로 늘어나고 질문 여러 개를 연속 채점할 때 파이썬 `for` 루프를 돌리면 속도가 느리다. 또한 `model.encode(query, convert_to_tensor=True)`가 반환하는 **파이토치(PyTorch) 텐서**를 그대로 넘기면 기존 함수는 타입 오류를 낸다.

이때 3절과 같은 함수 이름(`cosine_similarity`)으로 덮어쓰면서 반환 타입까지 파이썬 `list`로 바꾸면, 앞서 만든 `semantic_search_retrieve`의 `np.argsort(-similarity_scores)`가 리스트에 단항 `-` 연산을 적용하다 `TypeError`를 일으킨다. 이를 막기 위해 배치 행렬 연산 함수 이름을 **`cosine_similarity_batch`**로 분리하고 반환 타입도 일관되게 `np.ndarray`로 유지한다.

```python
def cosine_similarity_batch(v1, array_of_vectors) -> np.ndarray | float:
    """파이토치 텐서와 NumPy 배열을 모두 받아 2차원 행렬 곱(@)으로 일괄 코사인 유사도를 계산한다."""
    # 1. 입력 벡터가 GPU 텐서이거나 미분 추적 그래프(.detach)에 연결되어 있으면 CPU NumPy 배열로 분리
    if hasattr(v1, "detach"):
        v1 = v1.detach().cpu().numpy()
    v1 = np.asarray(v1, dtype=np.float32).ravel()

    if hasattr(array_of_vectors, "detach"):
        array_of_vectors = array_of_vectors.detach().cpu().numpy()
    A = np.asarray(array_of_vectors, dtype=np.float32)

    # 2. 비교 대상이 1차원 단일 벡터면 0 나눗셈을 막고 스칼라 유사도 반환
    if A.ndim == 1:
        A = A.ravel()
        denom = np.linalg.norm(v1) * np.linalg.norm(A)
        return float(0.0 if denom == 0 else np.dot(v1, A) / denom)

    # 3. 2차원 문서 행렬 A와 1차원 질문 벡터 v1의 내적(A @ v1)을 일괄 계산
    A = np.atleast_2d(A)
    v1_norm = np.linalg.norm(v1)
    A_norms = np.linalg.norm(A, axis=1)
    denom = v1_norm * A_norms

    # 4. 본문이 비어 크기가 0인 영벡터 문서에서 0 나눗셈 NaN이 생기지 않게 임시 치환 후 0.0 복원
    with np.errstate(divide='ignore', invalid='ignore'):
        sims = (A @ v1) / np.where(denom == 0, 1.0, denom)
    sims[denom == 0] = 0.0
    return sims
```

이 함수에서는 세 가지 안전장치가 핵심이다.
1. **PyTorch 텐서 분리 (`.detach().cpu().numpy()`)**: 미분 추적 그래프와 GPU 메모리에서 데이터를 떼어 낸 뒤 `np.asarray(..., dtype=np.float32)`로 불필요한 메모리 복사 없이 형식을 통일하고, `.ravel()`로 1차원 `(768,)` 모양을 맞춘다.
2. **행렬 곱(`A @ v1`) 일괄 내적**: 2차원 행렬 `A`(`11314 × 768`)와 질문 벡터 `v1`의 내적, 그리고 각 행의 크기(`np.linalg.norm(A, axis=1)`)를 한 번에 계산해 반복문 병목을 없앤다.
3. **영벡터 0 나눗셈 방어**: 빈 문서 때문에 분모 `denom`이 `0`이 된 칸은 `np.where(denom == 0, 1.0, denom)`으로 안전하게 나눈 뒤 해당 위치 점수만 `0.0`으로 덮어써 `NaN` 오염을 막는다.

### 보조 함수와 정밀도와 재현율 수식 구현

이제 텍스트 정제, 상위 $K$개 인덱스 추출, 정밀도(`precision_at_k`)와 재현율(`recall_at_k`) 함수를 정의한다.

```python
def preprocess_text(text: str) -> str:
    """질문 앞뒤 공백을 제거하고 소문자로 정규화한다."""
    return text.strip().lower()


def top_k_greatest_indices(scores, k: int) -> list[int]:
    """유사도 점수 배열에서 가장 큰 상위 K개 문서의 원본 인덱스를 반환한다."""
    # (인덱스, 점수) 쌍을 점수 기준(x[1])으로 내림차순 정렬해 상위 k개 위치 추출
    sorted_by_value = sorted(enumerate(scores), key=lambda x: x[1], reverse=True)
    return [index for index, _ in sorted_by_value[:k]]


def precision_at_k(relevant_count: int, k: int) -> float:
    """상위 K개 결과 중 실제 정답 문서가 차지하는 비율(Precision@K)을 계산한다."""
    if relevant_count < 0 or k < 0:
        raise ValueError("Both relevant_count and k must be non-negative.")
    if k == 0:
        return 0.0
    return relevant_count / k


def recall_at_k(relevant_count: int, total_relevant: int) -> float:
    """코퍼스 전체 정답 문서 중 상위 K개 안에 찾아낸 비율(Recall@K)을 계산한다."""
    if relevant_count < 0 or total_relevant < 0:
        raise ValueError("Both relevant_count and total_relevant must be non-negative.")
    if total_relevant == 0:
        return 0.0
    return relevant_count / total_relevant
```

`precision_at_k`와 `recall_at_k`는 음수 입력에 `ValueError`를 일으키고, 분모(`k` 또는 `total_relevant`)가 `0`일 때는 `ZeroDivisionError` 대신 `0.0`을 반환하도록 방어한다.

### 대규모 자동 채점 루프 `compute_metrics` 완성

준비된 함수들을 묶어 테스트 질문 리스트(`queries`)의 정밀도와 재현율을 일괄 측정하는 `compute_metrics`를 작성한다.

```python
def compute_metrics(queries: list[dict], embeddings, model, top_k: int = 5) -> list[dict]:
    """테스트 질문 목록에 대해 시맨틱 검색을 수행하고 Precision@K와 Recall@K를 계산한다."""
    results = []

    # 1. 임베딩 리스트를 루프 밖에서 (N, D) 단일 2차원 NumPy 행렬 E로 미리 합침
    np_embeddings = []
    for x in embeddings:
        if hasattr(x, "detach"):
            x = x.detach().cpu().numpy()
        np_embeddings.append(np.asarray(x, dtype=np.float32).ravel())
    E = np.vstack(np_embeddings)

    for item in queries:
        query = preprocess_text(item["query"])
        desired_category = item["desired_category"]

        # 2. 질문 인코딩 후 1차원 NumPy 벡터로 정규화해 행렬 E와 일괄 유사도 계산
        q_emb = model.encode(query, convert_to_tensor=True)
        if hasattr(q_emb, "detach"):
            q_emb = q_emb.detach().cpu().numpy()
        q_emb = np.asarray(q_emb, dtype=np.float32).ravel()

        cos_sim = cosine_similarity_batch(q_emb, E)
        top_results = top_k_greatest_indices(cos_sim, k=top_k)

        # 3. 상위 K개 문서의 실제 카테고리 이름과 데이터셋 내 해당 카테고리 전체 정답 수 계산
        retrieved_categories = [
            newsgroups_train.target_names[df.iloc[idx]["category"]] for idx in top_results
        ]
        relevant_in_top_k = sum(1 for cat in retrieved_categories if cat == desired_category)
        total_relevant_in_corpus = sum(
            1 for idx in range(len(df))
            if newsgroups_train.target_names[df.iloc[idx]["category"]] == desired_category
        )

        # 4. 지표 계산 및 결과 누적
        patk = precision_at_k(relevant_in_top_k, top_k)
        ratk = recall_at_k(relevant_in_top_k, total_relevant_in_corpus)

        results.append({
            "query": item["query"],
            "desired_category": desired_category,
            "K": top_k,
            "precision_at_k": patk,
            "recall_at_k": ratk,
            "relevant_in_top_k": relevant_in_top_k,
            "total_relevant_in_corpus": total_relevant_in_corpus,
            "retrieved_categories": retrieved_categories,
        })

    return results
```

이 함수는 루프 진입 전 `np.vstack`으로 11,314개 벡터를 단일 2차원 행렬 `E`로 쌓아 질문마다 행렬 곱이 즉시 실행되게 만든다. 이후 각 질문에서 뽑힌 상위 `top_k`개 행의 카테고리(`df.iloc[idx]["category"]`)를 정답 주제(`desired_category`)와 대조해 분자를 세고, 전체 코퍼스의 해당 주제 총건수로 나누어 정밀도와 재현율을 산출한다.

마지막으로 11개의 테스트 질문(`test_queries`)과 세 가지 조회 개수(`k_values = [5, 20, 50]`)로 평가 루프를 실행한다.

```python
test_queries = [
    {"query": " space exploration Moon landing Apollo missions ", "desired_category": "sci.space"},
    {"query": " heart disease cholesterol medical treatment ", "desired_category": "sci.med"},
    {"query": "3D graphics rendering OpenGL shader ", "desired_category": "comp.graphics"},
    {"query": " hockey NHL Stanley Cup playoffs ", "desired_category": "rec.sport.hockey"},
    {"query": " Windows operating system Microsoft drivers ", "desired_category": "comp.os.ms-windows.misc"},
    {"query": " firearm gun control legislation second amendment ", "desired_category": "talk.politics.guns"},
    {"query": " Christian faith evolution creationism morality ", "desired_category": "talk.religion.misc"},
    {"query": " Middle East peace talks Israel Palestine conflict ", "desired_category": "talk.politics.mideast"},
    {"query": " encryption security NSA privacy cryptography ", "desired_category": "sci.crypt"},
    {"query": " car engine transmission oil change maintenance ", "desired_category": "rec.autos"},
    {"query": " global conflict economy crisis intervention ", "desired_category": "talk.politics.misc"},
]

k_values = [5, 20, 50]

for k in k_values:
    print(f"\n=== Results for K={k} ===")
    metrics = compute_metrics(test_queries, embeddings, model, top_k=k)
    for m in metrics:
        print(f"Query: {m['query'].strip()}")
        print(f"  Desired Category: {m['desired_category']}")
        print(f"  Precision@{k}: {m['precision_at_k']:.2f} ({m['relevant_in_top_k']}/{k})")
        print(f"  Recall@{k}:    {m['recall_at_k']:.2f} ({m['relevant_in_top_k']}/{m['total_relevant_in_corpus']})\n")
```

```text
=== Results for K=5 ===
Query: space exploration Moon landing Apollo missions
  Desired Category: sci.space
  Precision@5: 1.00 (5/5)
  Recall@5:    0.01 (5/593)
...
Query: global conflict economy crisis intervention
  Desired Category: talk.politics.misc
  Precision@5: 0.20 (1/5)
  Recall@5:    0.00 (1/465)
```

출력된 결과를 통해 두 가지 현상을 확인할 수 있다. 첫째, 우주 과학(`sci.space`, 전체 정답 593건) 질문에서 5개를 모두 맞추더라도(`Precision@5 = 1.00`), 전체 분모가 크므로 `Recall@5`는 `5 / 593 = 0.01`(1%)에 머문다. $K$를 20, 50으로 늘리면 재현율은 `0.03`(20/593), `0.08`(46/593)로 오르는 대신 정밀도는 `0.92`(46/50)로 소폭 내려가는 트레이드오프가 나타난다.

둘째, `"global conflict economy crisis intervention"`처럼 여러 주제가 섞인 모호한 질의는 임베딩 공간에서 외교나 종교 문서들과 겹쳐 $K=5$ 정밀도가 `0.20`(1/5)에 머문다. 이번 평가 루프는 단일 시맨틱 검색만 측정한 결과다. 이처럼 다주제 질의에서 단일 임베딩 검색이 보이는 한계는, 앞서 구현한 키워드 검색(BM25) 및 역순위 융합(RRF)과 비교 평가로 개선 효과를 검증해야 할 출발점을 보여준다.

---

## 6. 참고 자료

- DeepLearning.AI — *Retrieval Augmented Generation (RAG)*, Module 2: "Information Retrieval Foundations" (Instructor: Zain Hasan, Andrew Ng)
