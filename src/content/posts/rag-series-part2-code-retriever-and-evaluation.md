---
title: "RAG 파이프라인 2편(실습): 하이브리드 검색기 구현과 정밀도·재현율 평가"
description: "사전 임베딩 로드부터 BM25 역색인, 코사인 유사도 기반 시맨틱 검색, RRF 순위 병합, 그리고 20 Newsgroups 데이터셋과 2차원 행렬 곱을 활용한 정밀도·재현율 자동 평가 루프까지 파이썬 코드로 단계별 조립한다."
pubDate: "2026-10-28 08:20:00"
tags: ["RAG", "BM25", "CosineSimilarity", "RRF", "Evaluation", "Python"]
categories: ["Architecture", "AI"]
draft: false
---

## 1. 검색 데이터와 사전 임베딩 준비

사전 학습된 대규모 언어 모델(LLM)은 학습 시점 이후에 발생한 최신 사건이나 사내 비공개 문서를 알지 못한다. 예를 들어 모델에게 2024년의 최신 경제 지표(GDP)나 스포츠 경기 결과를 물어보면 답변을 거부하거나 부정확한 정보를 생성한다.

이 문제를 해결하려면 외부 뉴스 데이터베이스에서 질문과 관련된 기사를 찾아 프롬프트에 참고 자료로 넣어주는 검색기(Retriever)가 필요하다. 이번 글에서는 이전 이론 편에서 다룬 **키워드 검색(BM25)**, **시맨틱 검색(코사인 유사도)**, **상호 순위 조합(RRF)**을 실제 파이썬 코드로 하나씩 구현하여 하이브리드 RAG 파이프라인을 완성한다. 이어서 구축한 검색기가 얼마나 정확한 문서를 찾아오는지 **정밀도($\text{Precision@}K$)**와 **재현율($\text{Recall@}K$)**로 자동 채점하는 평가 루프까지 순서대로 조립한다.

가장 먼저 할 일은 검색 대상이 되는 뉴스 기사 데이터를 메모리에 불러오고 데이터 구조를 확인하는 것이다.

```python
from utils import read_dataframe

NEWS_DATA = read_dataframe("news_data_dedup.csv")

# 첫 번째 뉴스 기사의 데이터 구조 확인
print(NEWS_DATA[0])
```

`from utils import read_dataframe`은 실습 환경의 보조 모듈(`utils.py`)에 정의된 CSV 파일 로드 함수를 불러온다. 이 함수로 중복 기사가 제거된 `"news_data_dedup.csv"` 파일을 읽으면, 수천 건의 뉴스 기사가 담긴 파이썬 리스트 `NEWS_DATA`가 생성된다. `NEWS_DATA[0]`을 출력해 보면 개별 기사가 어떤 형태의 딕셔너리로 저장되어 있는지 확인할 수 있다.

```python
{
    'guid': 'e2223829839c11303f8c279207b8a832',
    'title': 'Projection: Notably cooler snacks into next week',
    'description': 'Our authoritative attraction comes from an area of high pressure...',
    'venue': 'Action News Jax',
    'published_at': '2024-05-04 12:36:56+00:00',
    'url': 'https://www.actionnewsjax.com/news/local/...',
    'full_text': '...'
}
```

각 기사는 고유 식별자(`guid`), 제목(`title`), 본문 요약(`description`), 언론사(`venue`), 발행일(`published_at`), 링크(`url`) 등의 키를 가진 딕셔너리다.

전체 뉴스 데이터 리스트가 준비되었으니, 원하는 기사의 위치 번호(Index)들을 리스트로 넘기면 해당 기사들의 딕셔너리만 뽑아서 돌려주는 기본 조회 함수 `query_news`를 먼저 작성해 둔다.

```python
def query_news(indices: list[int]) -> list[dict]:
    """
    Retrieves elements from a dataset based on specified indices.

    Parameters:
    indices (list[int]): A list of integers specifying the indices of the elements to retrieve from the dataset.

    Returns:
    list[dict]: A list of dictionaries, where each dictionary represents an element from the dataset corresponding to an index in `indices`.
    """
    output = [NEWS_DATA[index] for index in indices]
    return output
```

함수 내부의 `[NEWS_DATA[index] for index in indices]`는 전달받은 정수 번호 리스트(`indices`, 예: `[0, 5]`)를 순회하며 `NEWS_DATA`에서 해당 번호의 기사 딕셔너리를 꺼내 새 리스트로 반환한다. 앞으로 만들 검색 함수들은 기사 본문 전체 대신 **문서 위치 번호(`list[int]`)**만 반환하도록 설계한다. 검색이 끝난 뒤 마지막에 이 `query_news` 함수를 호출하면 필요한 기사의 제목과 본문을 언제든 꺼낼 수 있다.

다음으로 시맨틱 검색에서 사용할 임베딩 모델과 사전 계산된 문서 벡터 파일을 메모리에 불러온다.

```python
import os
import joblib
from sentence_transformers import SentenceTransformer

model_name = os.path.join(os.environ['MODEL_PATH'], "BAAI/bge-base-en-v1.5")
model = SentenceTransformer(model_name)

EMBEDDINGS = joblib.load("embeddings.joblib")
```

이 코드는 실시간 검색 속도를 확보하기 위해 **오프라인 사전 색인**과 **온라인 질문 인코딩**을 분리하는 구성을 보여준다.

첫째 줄의 `os.environ['MODEL_PATH']`는 운영체제(OS) 환경 변수 딕셔너리에서 모델 파일들이 보관된 기본 폴더 경로(예: `"/ulas/models"`)를 가져온다. 개발자의 로컬 PC나 클라우드 서버마다 모델이 설치된 상위 폴더 위치가 달라도 파이썬 코드를 고치지 않기 위해 환경 변수를 사용한다.

이 기본 경로 문자열과 하위 모델 이름인 `"BAAI/bge-base-en-v1.5"`를 합칠 때 단순 덧셈(`+`)을 쓰면 경로 사이에 슬래시(`/`)가 빠지거나 중복되기 쉽다. 또한 윈도우(`\`)와 리눅스·맥(`/`)은 폴더 구분 기호가 서로 달라 에러가 난다. `os.path.join(경로1, 경로2)`는 현재 운영체제에 맞는 구분 기호를 자동으로 넣어 두 경로를 안전하게 이어 붙인다. 이어서 `SentenceTransformer(model_name)`을 호출하면 문장을 768차원 벡터로 변환해 주는 임베딩 모델 객체 `model`이 메모리에 로드된다.

마지막 줄의 `joblib.load("embeddings.joblib")`는 대용량 넘파이(NumPy) 배열이나 머신러닝 객체를 하드디스크에 이진 파일로 저장(`dump`)하고 불러오는(`load`) 라이브러리 함수다. 수천 건의 뉴스 기사를 검색할 때마다 `model.encode()`로 변환하면 수 분 이상이 소요된다. 따라서 전체 뉴스 기사는 사전에 한 번만 768차원 벡터로 변환하여 `embeddings.joblib` 파일로 저장해 두고, 프로그램이 시작될 때 메모리(`EMBEDDINGS`)로 즉시 불러온다. 반면 위에서 로드한 `model` 객체는 사용자가 실시간으로 입력하는 질문 문장 단 1개를 768차원 벡터로 변환할 때만 사용한다.

---

## 2. 키워드 검색과 BM25 역색인 구현

### 역색인 사전 구축

원본 데이터(`NEWS_DATA`)가 준비되었으므로 첫 번째 검색기인 키워드 기반 BM25 검색 함수를 만든다. 질문이 들어왔을 때 수천 건의 뉴스를 처음부터 끝까지 읽지 않으려면, 먼저 전체 뉴스를 단어 단위로 쪼개어 **어떤 단어가 몇 번 뉴스에 몇 번 등장하는지 정리한 역색인(Inverted Index) 사전**을 등록해 두어야 한다.

```python
import bm25s

# Create the corpus of text Chunk -> title + description
corpus = [x['title'] + " " + x['description'] for x in NEWS_DATA]

# Instantiate the retriever by passing the corpus data
BM25_RETRIEVER = bm25s.BM25(corpus=corpus)

# Tokenize the chunks
TOKENIZED_DATA = bm25s.tokenize(corpus)

# Index the tokenized chunks within the retriever
BM25_RETRIEVER.index(TOKENIZED_DATA)
```

위 네 줄의 사전 준비 코드는 다음 순서로 동작한다.
1. `corpus` 리스트 생성: `NEWS_DATA`에서 각 기사 딕셔너리 `x`를 꺼내 제목(`x['title']`)과 요약(`x['description']`)을 공백 하나(`" "`)를 사이에 두고 이어 붙인다. 이제 `corpus`는 각 기사의 전체 텍스트가 순서대로 담긴 문자열 리스트(`list[str]`)가 된다.
2. 검색기 객체 생성: `bm25s.BM25(corpus=corpus)`를 호출하여 BM25 검색기 객체를 만들면서, 방금 만든 원본 문자열 리스트 `corpus`를 내부에 함께 넣어 둔다. 이 설정 때문에 나중에 검색기에게 상위 문서를 찾아달라고 요청하면, 문서 번호가 아니라 **`corpus`에 들어 있던 뉴스 본문 문자열 자체**가 결과로 나온다.
3. 단어 토큰화: `bm25s.tokenize(corpus)`를 실행하여 전체 뉴스 문장들을 공백과 문장 부호 기준으로 쪼개고, `'the'`, `'is'` 같은 불용어를 제거한 핵심 단어(토큰)들의 집합으로 변환한다.
4. 역색인 등록: `BM25_RETRIEVER.index(TOKENIZED_DATA)`를 호출하여 단어별 출현 빈도(TF)와 역문서 빈도(IDF), 문서 길이 정규화 값을 미리 계산해 검색기 내부 사전에 등록(`.index`)한다.

### `bm25_retrieve` 함수 작성과 차원 추적

역색인 사전(`BM25_RETRIEVER`)이 구축되었으니, 사용자의 질문(`query`)과 가져올 문서 개수(`top_k`)를 입력받아 상위 문서의 위치 번호 리스트(`list[int]`)를 반환하는 `bm25_retrieve` 함수를 구현한다.

```python
def bm25_retrieve(query: str, top_k: int = 5) -> list[int]:
    """
    Retrieves the top k relevant documents for a given query using the BM25 algorithm.

    This function tokenizes the input query and uses a pre-indexed BM25 retriever to
    find the most relevant documents. It returns the indices of the top k documents.

    Args:
        query (str): The search query for which relevant documents need to be retrieved.
        top_k (int): The number of top relevant documents to retrieve. Default value is 5.

    Returns:
        List[int]: A list of indices corresponding to the top k most relevant documents
        in the corpus.
    """
    # Tokenize the query using the 'tokenize' function from the 'bm25s' module
    tokenized_query = bm25s.tokenize(query)

    # Use the 'BM25_RETRIEVER' to retrieve documents and their scores based on the tokenized query
    # Retrieve the top 'k' documents
    results, scores = BM25_RETRIEVER.retrieve(tokenized_query, k=top_k)

    # Extract the first element from 'results' to get the list of retrieved documents
    results = results[0]

    # Convert the retrieved documents into their corresponding indices in the results list
    top_k_indices = [corpus.index(doc) for doc in results]

    return top_k_indices
```

코드가 네 줄로 간결하지만 각 줄을 거칠 때마다 데이터의 차원과 형태가 바뀌므로, 실제 질문 예시인 `"What are the recent news about GDP?"`(`top_k=5`)를 넣었을 때 데이터가 어떻게 변하는지 한 줄씩 추적해 본다.

첫째 줄인 `tokenized_query = bm25s.tokenize(query)`는 입력된 질문 문자열을 문서 사전과 대조할 수 있도록 똑같은 방식으로 쪼갠다. 질문에 있던 `'what'`, `'are'`, `'the'`, `'about'` 같은 불용어는 걸러지고 `[['recent', 'news', 'gdp']]`처럼 핵심 키워드 토큰만 남는다.

둘째 줄인 `results, scores = BM25_RETRIEVER.retrieve(tokenized_query, k=top_k)`는 등록된 역색인 사전을 탐색하여 점수가 가장 높은 상위 5개 문서(`results`)와 각 문서의 BM25 점수(`scores`)를 튜플로 꺼내온다. 이 줄을 작성할 때는 흔히 겪는 두 가지 실수를 피해야 한다.
- **`.index()`와 `.retrieve()` 구분**: 사전 준비 단계에서 썼던 `.index()`는 데이터를 사전에 등록하는 함수이고, 질문을 넣어 문서를 검색해 꺼내오는 함수는 `.retrieve()`다.
- **`k=top_k` 키워드 인자 명시**: `BM25_RETRIEVER.retrieve(query_tokens, corpus=None, k=10, ...)` 메서드의 정의를 보면 두 번째 위치 인자는 `k`가 아니라 `corpus`다. 만약 `k=`를 생략하고 `retrieve(tokenized_query, top_k)`라고 적으면, 파이썬이 두 번째 자리인 `corpus` 인자에 숫자 `5`를 집어넣어 에러가 발생한다. 따라서 반드시 `k=top_k`로 인자 이름을 지정해야 한다.

셋째 줄인 `results = results[0]`은 2차원 배열로 반환된 검색 결과에서 바깥쪽 대괄호를 제거하여 안쪽 리스트를 꺼내는 작업이다. `bm25s`의 `.retrieve()`는 질문 여러 개를 한 번에 묶어서(Batch) 검색할 수 있도록 설계되어 있다. 그래서 지금처럼 질문 1개만 넣어도 반환값 `results`는 아래와 같이 **질문 개수(1개) × 상위 문서 개수(5개)**의 2차원 구조로 나온다.

```python
# retrieve() 직후의 results (바깥 대괄호 안에 첫 번째 질문의 결과 리스트가 들어 있음)
results = [
    ["752번 뉴스 본문 문자열...", "673번 뉴스 본문 문자열...", "289번...", "626번...", "43번..."]
]
```

따라서 우리가 넣은 첫 번째(`0`번) 질문에 대한 문서 목록만 꺼내기 위해 `results = results[0]`을 실행한다. 이 줄을 통과하면 `results`는 5개의 뉴스 본문 문자열이 나란히 담긴 1차원 리스트(`["752번 본문...", "673번 본문...", ...]`)가 된다.

넷째 줄인 `top_k_indices = [corpus.index(doc) for doc in results]`는 본문 문자열을 문서 번호(정수)로 바꾸는 단계다. 앞서 `BM25(corpus=corpus)`로 검색기를 만들었기 때문에 `results` 안에는 문서 번호가 아니라 실제 뉴스 본문 문자열(`doc`)이 들어 있다. 우리가 최종적으로 반환해야 하는 것은 문서의 위치 번호 리스트(`list[int]`)다. 파이썬 리스트의 `.index(값)` 메서드는 리스트 안에서 해당 값과 일치하는 첫 번째 원소의 위치 번호를 찾아 돌려준다. 따라서 `results`에서 뉴스 본문 문자열 `doc`을 하나씩 꺼내 원본 전체 리스트인 `corpus`에서 몇 번째 칸에 있었는지(`corpus.index(doc)`) 역추적한다.

여기서 특히 주의할 점은 셋째 줄에서 이미 `results = results[0]`으로 1차원 리스트를 꺼내 놓고, 넷째 줄 리스트 컴프리헨션에서 또다시 `[corpus.index(doc) for doc in results[0]]`처럼 `[0]`을 중복해서 붙이지 않는 것이다. 이미 1차원 문서 리스트가 된 `results`에 다시 `[0]`을 붙이면 1등 문서의 문자열(`"752번 뉴스 본문..."`) 하나만 선택된다. 그 상태로 `for doc in results[0]`을 실행하면 파이썬은 문자열에서 알파벳을 한 글자씩(`'7'`, `'5'`, `'2'`, ...) 떼어내어 `corpus`에서 찾으려 하므로 `ValueError`가 발생한다.

작성한 `bm25_retrieve` 함수를 실행하고, 반환된 인덱스 번호를 1절에서 만든 `query_news`에 넣어 실제로 GDP 관련 뉴스가 찾아졌는지 확인한다.

```python
bm25_indices = bm25_retrieve("What are the recent news about GDP?")
print("BM25 Top-5 Indices:", bm25_indices)
# 출력: BM25 Top-5 Indices: [752, 673, 289, 626, 43]

# 1위로 검색된 752번 뉴스의 제목 확인
top_bm25_news = query_news([bm25_indices[0]])
print("1위 뉴스 제목:", top_bm25_news[0]['title'])
```

출력된 번호 `[752, 673, 289, 626, 43]`은 원본 `NEWS_DATA`에서 키워드 `"GDP"`와 매칭 점수가 가장 높은 상위 5개 뉴스의 위치 번호다.

---

## 3. 코사인 연산과 시맨틱 검색 구현

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

간혹 임베딩 예제 코드에서 `model.encode(query)[:40]`처럼 뒤에 슬라이싱을 붙이는 경우가 있다. 이는 768개의 소수점 숫자를 화면에 전부 출력하면 너무 길어지므로 눈으로 확인하기 위해 앞의 40개 숫자만 잘라 본 것일 뿐이다. 실제 검색 함수에서 벡터를 `[:40]`으로 자르면 나머지 728개 차원의 의미 정보가 사라지고 기존 문서 벡터(768차원)와 길이도 맞지 않게 되므로, 검색 시에는 슬라이싱 없이 `model.encode(query)` 전체를 그대로 사용해야 한다.

이제 질문 벡터 `v1`과 문서 벡터들의 묶음인 `array_of_vectors`를 받아 코사인 유사도($\frac{v_1 \cdot v_2}{\lVert v_1 \rVert \lVert v_2 \rVert}$)를 계산하는 `cosine_similarity` 함수를 살펴본다.

```python
import numpy as np


def cosine_similarity(v1, array_of_vectors):
    """
    Compute the cosine similarity between a vector and an array of vectors.

    Parameters:
    v1 (array-like): The first vector.
    array_of_vectors (array-like): An array of vectors or a single vector.

    Returns:
    list: A numpy array of cosine similarities between v1 and each vector in array_of_vectors.
    """
    # Ensure that v1 is a numpy array
    v1 = np.array(v1)
    # Initialize a list to store similarities
    similarities = []

    # Check if array_of_vectors is a single vector
    if len(np.shape(array_of_vectors)) == 1:
        array_of_vectors = [array_of_vectors]

    # Iterate over each vector in the array
    for v2 in array_of_vectors:
        # Convert the current vector to a numpy array
        v2 = np.array(v2)
        # Compute the dot product of v1 and v2
        dot_product = np.dot(v1, v2)
        # Compute the norms of v1 and v2
        norm_v1 = np.linalg.norm(v1)
        norm_v2 = np.linalg.norm(v2)
        # Compute the cosine similarity and append to the list
        similarity = dot_product / (norm_v1 * norm_v2)
        similarities.append(similarity)

    return np.array(similarities)
```

이 함수에 사용된 넘파이(NumPy) 함수들과 동작 순서를 하나씩 짚어본다.
- **`np.shape(array_of_vectors)`와 1차원 분기**: `np.shape()`는 배열이 몇 행 몇 열로 이루어져 있는지 차원 모양을 튜플로 알려준다. 만약 비교 대상으로 문서 여러 개(`(N, 768)`, 길이 2짜리 튜플)가 아니라 단일 문장 벡터 1개(`(768,)`, 길이 1짜리 튜플)만 들어오면 `len(np.shape(...)) == 1`이 참이 된다. 이때 아래쪽 `for v2 in array_of_vectors:` 반복문이 숫자 하나씩을 꺼내지 않고 벡터 단위로 돌 수 있도록, `[array_of_vectors]`처럼 바깥에 대괄호를 한 번 더 감싸 2차원 구조로 맞춘다.
- **`np.dot(v1, v2)` (분자 — 내적)**: 두 1차원 벡터 `v1`과 `v2`의 같은 위치에 있는 숫자끼리 곱한 뒤 모두 더한 값($\sum v_{1i} v_{2i}$)을 계산한다.
- **`np.linalg.norm(v1)` (분모 — 벡터의 크기)**: 선형대수 모듈(`linalg`)의 `norm` 함수는 각 원소를 제곱해 더한 뒤 루트를 씌운 벡터의 기하학적 길이($\sqrt{\sum v_{1i}^2}$)를 구한다. 내적 값을 두 벡터의 길이 곱(`norm_v1 * norm_v2`)으로 나누면 벡터의 길이에 상관없이 순수한 방향의 유사도(`-1.0`\~`1.0`)가 도출된다.
- **반환 타입 (`np.array(similarities)`)**: 계산된 유사도 리스트를 넘파이 배열로 변환해 반환한다. 단일 벡터 1개와 비교했더라도 앞서 `[array_of_vectors]`로 감싸서 반복문을 돌렸기 때문에 결과는 항상 `array([0.724])`처럼 1차원 배열로 나온다. 따라서 두 문장만 단독으로 비교해 숫자 하나를 꺼낼 때는 `cosine_similarity(q1_emb, q2_emb)[0]`처럼 끝에 `[0]`을 붙인다.

### `semantic_search_retrieve` 구현과 부호 반전 정렬

위 `cosine_similarity` 함수와 1절에서 불러온 전체 뉴스 벡터 `EMBEDDINGS`를 사용하여 상위 $K$개 문서의 위치 번호를 찾아내는 `semantic_search_retrieve` 함수를 작성한다.

```python
def semantic_search_retrieve(query: str, top_k: int = 5) -> list[int]:
    """
    Retrieves the top k relevant documents for a given query using semantic search and cosine similarity.

    This function generates an embedding for the input query and compares it against pre-computed document
    embeddings using cosine similarity. The indices of the top k most similar documents are returned.

    Args:
        query (str): The search query for which relevant documents need to be retrieved.
        top_k (int): The number of top relevant documents to retrieve. Default value is 5.

    Returns:
        List[int]: A list of indices corresponding to the top k most relevant documents in the corpus.
    """
    # Generate the embedding for the query using the pre-trained model
    query_embedding = model.encode(query)

    # Calculate the cosine similarity scores between the query embedding and the pre-computed document embeddings
    similarity_scores = cosine_similarity(query_embedding, EMBEDDINGS)

    # Sort the similarity scores in descending order and get the indices
    similarity_indices = np.argsort(-similarity_scores)

    # Select the indices of the top k documents as a numpy array
    top_k_indices_array = similarity_indices[0:top_k]

    # Cast them to int
    top_k_indices = [int(x) for x in top_k_indices_array]

    return top_k_indices
```

이 함수는 다섯 단계로 실행된다. 먼저 `model.encode(query)`로 질문을 768차원 벡터(`query_embedding`)로 변환한다. 이어서 `cosine_similarity(query_embedding, EMBEDDINGS)`를 호출하면 전체 뉴스 기사 각각에 대한 코사인 유사도 점수가 담긴 넘파이 배열 `similarity_scores`가 반환된다.

세 번째 줄인 `similarity_indices = np.argsort(-similarity_scores)`는 계산된 유사도 점수를 기준으로 문서 번호를 정렬한다.

만약 일반 정렬 함수인 `np.sort(similarity_scores)`를 쓰면 유사도 점수 숫자들만 크기순으로 줄을 설 뿐, 1등 점수를 받은 기사가 원래 몇 번 뉴스였는지(위치 번호)가 사라져 버린다. 반면 `np.argsort`는 배열을 정렬했을 때 **각 자리에 와야 할 원래 원소의 위치 번호(Index)**를 배열로 돌려준다.

여기서 `similarity_scores` 앞에 마이너스(`-`) 부호를 붙인 이유가 중요하다. 넘파이의 `np.argsort`는 기본적으로 **작은 숫자부터 큰 숫자 순서(오름차순)**로만 정렬하며, 내림차순 정렬 옵션이 따로 없다. 하지만 우리가 원하는 것은 유사도 점수가 **가장 큰** 기사부터 맨 앞에 오는 내림차순 정렬이다.

이때 넘파이 배열인 `similarity_scores` 앞에 `-`를 붙이면 배열 안의 모든 점수 부호가 반대로 뒤집힌다. 예를 들어 0번, 1번, 2번 기사의 유사도 점수가 `array([0.2, 0.9, 0.5])`라고 가정해 보자.
- 그냥 `np.argsort([0.2, 0.9, 0.5])`를 실행하면 가장 작은 `0.2`(0번 기사)가 맨 앞으로 와서 `[0, 2, 1]`이 된다.
- 앞에 `-`를 붙여 부호를 뒤집으면 `array([-0.2, -0.9, -0.5])`가 된다.
- 이제 `np.argsort([-0.2, -0.9, -0.5])`를 실행하면 음수 중에서 가장 작은 값인 `-0.9`(원래 점수가 `0.9`로 가장 컸던 1번 기사)가 맨 앞(1등)에 오고, 그다음 `-0.5`(2번), `-0.2`(0번) 순으로 정렬되어 우리가 원하는 내림차순 인덱스 배열 `[1, 2, 0]`을 정확히 얻을 수 있다.

이어서 `similarity_indices[0:top_k]` 슬라이싱으로 상위 $K$개의 번호만 잘라낸다. 마지막 줄인 `[int(x) for x in top_k_indices_array]`는 넘파이 전용 정수 타입(`numpy.int64`)으로 들어 있는 각 원소 `x`를 파이썬 기본 정수(`int`)로 변환하는 작업이다. 이렇게 캐스팅해 두어야 2절에서 만든 `bm25_retrieve`와 반환 타입(`list[int]`)이 일치한다.

작성한 함수를 앞서와 동일한 질문으로 실행하여 결과를 확인한다.

```python
semantic_indices = semantic_search_retrieve("What are the recent news about GDP?")
print("Semantic Top-5 Indices:", semantic_indices)
# 출력: Semantic Top-5 Indices: [743, 673, 626, 752, 326]
```

2절의 BM25 결과(`[752, 673, 289, 626, 43]`)와 비교해 보면 `673`, `626`, `752`번 기사는 두 검색기 모두 상위 5개 안에 뽑았지만, 시맨틱 검색기는 `"GDP"`라는 단어가 직접 덜 나오더라도 경제 성장 문맥을 담은 `743`번 기사를 1위로 찾아낸 것을 볼 수 있다.

---

## 4. RRF 순위 병합과 파이프라인 조립

### `reciprocal_rank_fusion` 구현과 병합 확인

지금까지 만든 `bm25_retrieve`와 `semantic_search_retrieve`는 같은 질문에 대해 서로 다른 순서의 문서 번호 리스트를 내놓았다. 두 검색기의 장점을 모두 살리려면 양쪽의 순위 리스트(`list1`, `list2`)를 하나로 합쳐 최종 순위를 매기는 상호 순위 조합(Reciprocal Rank Fusion, RRF) 함수가 필요하다.

각 문서가 받는 RRF 점수는 $\text{RRF\_Score} = \sum \frac{1}{\text{rank} + K}$ 공식으로 계산한다. 이를 파이썬 코드로 구현한다.

```python
def reciprocal_rank_fusion(list1: list[int], list2: list[int], top_k: int = 5, K: int = 60) -> list[int]:
    """
    Fuse rank from multiple IR systems using Reciprocal Rank Fusion.

    Args:
        list1 (list[int]): A list of indices of the top-k documents that match the query.
        list2 (list[int]): Another list of indices of the top-k documents that match the query.
        top_k (int): The number of top documents to consider from each list for fusion. Defaults to 5.
        K (int): A constant used in the RRF formula. Defaults to 60.

    Returns:
        list[int]: A list of indices of the top-k documents sorted by their RRF scores.
    """
    # Create a dictionary to store the RRF scores for each document index
    rrf_scores = dict()

    # Iterate over each document list
    for lst in [list1, list2]:
        # Calculate the RRF score for each document index
        for rank, item in enumerate(lst, start=1):
            # If the item is not in the dictionary, initialize its score to 0
            if item not in rrf_scores:
                rrf_scores[item] = 0
            # Update the RRF score for each document index using the formula 1 / (rank + K)
            rrf_scores[item] += 1 / (rank + K)

    # Sort the document indices based on their RRF scores in descending order
    sorted_items = sorted(rrf_scores, key=rrf_scores.get, reverse=True)

    # Slice the list to get the top-k document indices
    top_k_indices = [int(x) for x in sorted_items[0:top_k]]

    return top_k_indices
```

코드의 흐름을 단계별로 살펴본다.
1. **점수 딕셔너리 생성 (`rrf_scores = dict()`)**: 문서 번호(예: `673`)를 키(Key)로 삼고, 그 문서가 양쪽 리스트에서 받은 RRF 점수의 합계를 값(Value)으로 기록할 빈 딕셔너리를 만든다.
2. **이중 반복문과 `enumerate(lst, start=1)`**: 바깥쪽 반복문 `for lst in [list1, list2]:`는 첫 번째 검색 결과 리스트와 두 번째 검색 결과 리스트를 차례대로 꺼낸다. 안쪽 반복문 `for rank, item in enumerate(lst, start=1):`는 리스트 안에서 각 문서의 순위(`rank`)와 문서 번호(`item`)를 동시에 추출한다. 파이썬 리스트의 인덱스는 원래 `0`부터 시작하지만, 검색 순위(Rank)는 1등(`1`)부터 시작해야 수식이 성립한다. 따라서 `start=1` 옵션을 지정해 첫 번째 원소의 `rank`가 `1`, 두 번째가 `2`가 되도록 맞춘다.
3. **점수 초기화 및 누적 (`+= 1 / (rank + K)`)**: 만약 꺼낸 문서 번호 `item`이 `rrf_scores` 딕셔너리에 아직 없다면(`if item not in rrf_scores:`), 먼저 점수를 `0`으로 초기화한다. 그다음 `rrf_scores[item] += 1 / (rank + K)`를 실행해 점수를 더한다. 한쪽 리스트에만 있는 문서는 점수가 한 번만 더해지고, 양쪽 리스트에 모두 등장한 문서는 두 점수가 합산된다.
4. **값(점수) 기준 내림차순 정렬 (`sorted`)**: `sorted(rrf_scores, key=rrf_scores.get, reverse=True)`는 누적된 점수가 가장 높은 순서대로 문서 번호를 정렬한다. 파이썬에서 딕셔너리를 그냥 `sorted(rrf_scores)`에 넣으면 키(문서 번호 숫자) 크기순으로 정렬되어 버린다. 우리가 원하는 것은 문서 번호가 아니라 **그 문서에 저장된 RRF 점수(Value)**를 기준으로 정렬하는 것이다. 따라서 정렬 기준을 지정하는 `key` 인자에 키로 값을 꺼내주는 메서드인 `rrf_scores.get`을 넘기고, `reverse=True`를 지정해 점수가 큰 문서부터 줄을 세운다.

2절과 3절에서 각각 얻었던 시맨틱 검색 결과(`semantic_indices`)와 BM25 검색 결과(`bm25_indices`)를 이 함수에 넣어 실제로 순위가 어떻게 합쳐지는지 확인해 본다.

```python
# list1(시맨틱): [743, 673, 626, 752, 326]
# list2(BM25):   [752, 673, 289, 626, 43]
rrf_indices = reciprocal_rank_fusion(semantic_indices, bm25_indices, top_k=5)
print("RRF Top-5 Indices:", rrf_indices)
# 출력: RRF Top-5 Indices: [673, 752, 626, 743, 289]
```

결과를 보면 시맨틱 검색과 BM25 양쪽에서 모두 2등을 차지해 점수가 두 번 누적된 `673`번 기사가 단독 1위였던 `743`번과 `752`번보다 높은 합산 점수를 받아 최종 1위로 정렬된 것을 확인할 수 있다.

### 최종 프롬프트 조립 (`generate_final_prompt`)과 LLM 연결

세 가지 검색 함수(`bm25_retrieve`, `semantic_search_retrieve`, `reciprocal_rank_fusion`)가 모두 완성되었다. 이제 이 함수들을 선택적으로 호출하여 검색된 뉴스 기사를 프롬프트에 합쳐 주는 `generate_final_prompt` 함수를 조립한다.

```python
def generate_final_prompt(query: str, top_k: int, retrieve_function: callable = None, use_rag: bool = True) -> str:
    """
    Generates an augmented prompt for a Retrieval-Augmented Generation (RAG) system by retrieving the top_k most
    relevant documents based on a given query.
    """
    # Define the prompt as the initial query
    prompt = query

    # If not using rag, return the prompt
    if not use_rag:
        return prompt

    # Determine which retrieve function to use based on its name.
    if retrieve_function.__name__ == 'reciprocal_rank_fusion':
        # Retrieve top documents using two different methods.
        list1 = semantic_search_retrieve(query=query, top_k=top_k)
        list2 = bm25_retrieve(query=query, top_k=top_k)
        # Combine the results using reciprocal rank fusion.
        top_k_indices = retrieve_function(list1, list2, top_k=top_k)
    else:
        # Use the provided retrieve function.
        top_k_indices = retrieve_function(query=query, top_k=top_k)

    # Retrieve documents from the dataset using the indices.
    relevant_documents = query_news(top_k_indices)

    formatted_documents = []

    # Iterate over each retrieved document.
    for document in relevant_documents:
        # Format each document into a structured string.
        formatted_document = (
            f"Title: {document['title']}, Description: {document['description']}, "
            f"Published at: {document['published_at']}\nURL: {document['url']}"
        )
        # Append the formatted string to the main data string with a newline for separation.
        formatted_documents.append(formatted_document)

    retrieve_data_formatted = "\n".join(formatted_documents)

    prompt = (
        f"Answer the user query below. There will be provided additional information for you to compose your answer. "
        f"The relevant information provided is from 2024 and it should be added as your overall knowledge to answer the query, "
        f"you should not rely only on this information to answer the query, but add it to your overall knowledge."
        f"\nQuery: {query}\n"
        f"2024 News: {retrieve_data_formatted}"
    )

    return prompt
```

이 함수는 세 단계로 프롬프트를 완성한다.
1. **함수 객체를 인자로 전달 (`retrieve_function: callable`)**: 파이썬에서는 함수도 변수처럼 다른 함수의 인자로 넘길 수 있으며, 이처럼 호출 가능한 함수 타입을 `callable`이라 표기한다. 또한 모든 함수 객체는 자신의 이름을 문자열로 담고 있는 `.__name__` 속성을 가진다. 만약 인자로 `reciprocal_rank_fusion` 함수를 넘기면 `retrieve_function.__name__ == 'reciprocal_rank_fusion'`이 참이 되어, 내부에서 `semantic_search_retrieve`와 `bm25_retrieve`를 둘 다 실행한 뒤 그 결과를 병합한다. 반면 `bm25_retrieve`나 `semantic_search_retrieve`를 넘기면 `else:` 블록으로 가서 해당 함수만 단독 실행한다.
2. **원본 기사 조회 및 문자열 결합 (`query_news` & `"\n".join`)**: 검색 함수가 반환한 5개의 정수 번호 리스트(`top_k_indices`)를 1절에서 만든 `query_news(top_k_indices)`에 넣으면 5개 기사의 딕셔너리 리스트(`relevant_documents`)가 나온다. 반복문을 돌며 각 기사의 제목, 요약, 발행일, URL을 지정된 형식의 문자열로 조합해 `formatted_documents` 리스트에 담은 뒤, `"\n".join(formatted_documents)`를 호출해 리스트 안의 문자열 5개를 줄바꿈 기호(`\n`)로 이어 붙여 단일 텍스트 블록으로 만든다.
3. **최종 프롬프트 생성 및 LLM 호출**: 사용자의 원래 질문(`Query:`) 아래에 방금 만든 뉴스 텍스트(`2024 News:`)를 덧붙여 확장된 프롬프트를 반환한다.

완성된 프롬프트 생성 함수를 보조 모듈(`utils.py`)의 언어 모델 호출 함수인 `llm_call`과 연결하면 전체 RAG 시스템이 작동한다.

```python
from utils import llm_call

user_query = "What are the recent news about GDP?"

# RRF 하이브리드 검색기를 사용하여 배경지식이 결합된 프롬프트 생성
augmented_prompt = generate_final_prompt(
    query=user_query,
    top_k=5,
    retrieve_function=reciprocal_rank_fusion,
    use_rag=True
)

# 완성된 프롬프트를 LLM에 전달하여 최종 답변 생성
response = llm_call(augmented_prompt)
print(response)
```

---

## 5. 정밀도·재현율 평가 루프 구현

### 평가용 20 Newsgroups 데이터셋과 판다스 표 구성

4절까지 구현한 하이브리드 검색기가 질문에 맞는 문서를 얼마나 정확히 찾아오는지 객관적인 수치로 검증한다.

앞선 1\~4절에서 사용한 뉴스 데이터(`news_data_dedup.csv`)에는 각 기사가 어떤 주제에 속하는지 표시된 정답 라벨(Ground Truth)이 없다. 정답이 표시되어 있지 않으면 검색기가 뽑아온 5개 기사 중 몇 개가 정답인지 컴퓨터가 자동으로 계산할 수 없다. 따라서 검색기의 정밀도($\text{Precision@}K$)와 재현율($\text{Recall@}K$)을 정량 평가하기 위해, 모든 문서에 20개 주제 중 하나의 정답 번호가 매겨져 있는 사이킷런(scikit-learn)의 **20 Newsgroups 벤치마크 데이터셋**을 불러온다.

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

print(df.head())
print("Data shape:", df.shape)
# 출력: Data shape: (11314, 2)
```

`fetch_20newsgroups` 함수에 전달한 네 가지 인자는 실험 조건을 통제하는 역할을 한다.
- `subset='train'`: 전체 데이터 중 학습용(Train)으로 분류된 11,314건의 게시글을 가져온다.
- `shuffle=True`: 게시글들이 주제별로 뭉쳐 있지 않도록 순서를 무작위로 섞는다.
- `random_state=42`: 무작위로 섞을 때 난수 시드(Seed) 번호를 `42`로 고정한다. 이 번호를 고정해 두면 코드를 언제 다시 실행해도 11,314개 문서의 섞인 순서가 항상 동일하게 유지된다.
- `data_home='./dataset'`: 다운로드한 원본 데이터를 현재 작업 폴더 아래 `./dataset`에 저장하여 재실행 시 다시 다운로드하지 않게 한다.

불러온 데이터는 판다스(Pandas)의 `pd.DataFrame`을 사용해 2차원 표(엑셀 시트 형태) 변수인 `df`로 만든다. 첫 번째 열인 `'text'`에는 게시글 본문 문자열(`newsgroups_train.data`)을 넣고, 두 번째 열인 `'category'`에는 해당 글이 속한 주제 번호(`newsgroups_train.target`, `0`\~`19` 사이의 정수)를 나란히 붙인다.

`df.head()`는 11,314개 행을 화면에 다 띄우지 않고 맨 위 5개 행만 미리보기로 출력하는 함수다. 출력된 표를 보면 각 글의 본문 옆에 `7`, `4` 같은 카테고리 번호가 붙어 있고, `df.shape`를 통해 전체 표가 11,314개 행과 2개 열(`(11314, 2)`)로 이루어져 있음을 확인할 수 있다.

`0`\~`19`번 숫자가 실제로 어떤 주제 이름을 뜻하는지는 `newsgroups_train.target_names` 리스트에 순서대로 들어 있다.

```python
print(newsgroups_train.target_names)
# 출력:
# ['alt.atheism', 'comp.graphics', 'comp.os.ms-windows.misc', ...,
#  'sci.med', 'sci.space', ..., 'talk.politics.misc', 'talk.religion.misc']
```

이처럼 본문 옆에 카테고리 번호를 붙여 표(`df`)로 만든 이유는 **질문에 따른 동적 채점**을 자동화하기 위해서다. 개별 문서에 고정된 `True`/`False` 라벨이 부여되어 있는 것이 아니다. 예를 들어 500번 문서의 카테고리가 우주 과학(`sci.space`)일 때, 사용자가 우주 탐사 질문을 던지면 이 문서는 정답(`Relevant`)이 되지만, 같은 검색기에 의학(`sci.med`) 질문을 던지면 오답(`Non-relevant`)이 된다. 즉, 각 평가 질문마다 요구하는 정답 카테고리(`desired_category`)를 지정해 두고, 검색기가 찾아온 문서의 행 번호로 `df`의 `category` 열을 조회해 두 주제가 일치하는지 실시간으로 비교한다.

평가를 위해 20 Newsgroups의 11,314개 문서를 사전에 임베딩해 둔 벡터 파일(`embeddings`)과 임베딩 모델(`model`)을 불러온다.

```python
import joblib
from sentence_transformers import SentenceTransformer

model_name = '/ulas/models/BAAI/bge-base-en-v1.5'
model = SentenceTransformer(model_name)

embeddings = joblib.load('/ulas/models/embeddings.joblib')
```

### 1만 건 이상 대규모 연산을 위한 `cosine_similarity` 고도화

본격적인 평가에 앞서 3절에서 작성했던 `cosine_similarity` 함수를 돌아볼 필요가 있다. 3절의 함수는 파이썬 `for` 반복문으로 문서 벡터를 하나씩 꺼내 내적을 계산했다. 하지만 지금처럼 문서가 11,314건으로 늘어나고 질문도 여러 개를 연속으로 채점해야 하는 환경에서 파이썬 `for`문을 돌리면 연산 속도가 크게 떨어진다. 게다가 `model.encode(query, convert_to_tensor=True)`처럼 입력 벡터가 넘파이 배열이 아닌 **파이토치(PyTorch) 텐서**로 들어오면 기존 함수에서는 타입 에러가 발생한다.

이 두 가지 문제를 해결하기 위해, 파이토치 텐서를 CPU 넘파이 배열로 안전하게 정규화하고 `for`문 대신 **2차원 행렬 곱(`@`)**으로 11,314개 유사도를 단 한 번에 계산하도록 업그레이드한 `cosine_similarity` 함수를 작성한다.

```python
def cosine_similarity(v1, array_of_vectors):
    # Ensure v1 is a 1D numpy array on CPU
    if hasattr(v1, "detach"):
        v1 = v1.detach().cpu().numpy()
    v1 = np.asarray(v1, dtype=np.float32).ravel()

    # Ensure array_of_vectors is a 2D numpy array on CPU
    if hasattr(array_of_vectors, "detach"):
        array_of_vectors = array_of_vectors.detach().cpu().numpy()
    A = np.asarray(array_of_vectors, dtype=np.float32)

    if A.ndim == 1:
        A = A.ravel()
        denom = np.linalg.norm(v1) * np.linalg.norm(A)
        return float(0.0 if denom == 0 else np.dot(v1, A) / denom)

    # 2D case: each row in A is a vector
    A = np.atleast_2d(A)
    v1_norm = np.linalg.norm(v1)
    A_norms = np.linalg.norm(A, axis=1)
    denom = v1_norm * A_norms
    # Safe division
    with np.errstate(divide='ignore', invalid='ignore'):
        sims = (A @ v1) / np.where(denom == 0, 1.0, denom)
    sims[denom == 0] = 0.0
    return sims.tolist()
```

이 함수에 추가된 데이터 전처리 및 행렬 연산 문법을 차례대로 짚어본다.

첫째는 `if hasattr(v1, "detach"):` 블록을 통한 **파이토치 텐서 분리 및 변환**이다. 파이토치는 신경망을 학습시킬 때 역전파(Backpropagation) 미분을 계산하기 위해, 텐서가 어떤 덧셈과 곱셈을 거쳐 만들어졌는지 **계산 그래프(Computational Graph, 미분 추적 기록)**를 함께 기록해 둔다. 이 미분 추적 기록이 남아 있거나 데이터가 GPU 메모리에 올라가 있으면, CPU 전용 C언어 라이브러리인 넘파이 배열로 변환할 때 에러가 발생한다. 따라서 파이썬 내장 함수 `hasattr(객체, "속성이름")`로 `v1`이 `"detach"` 기능을 가진 파이토치 텐서인지 확인한 뒤, 세 단계를 순서대로 거친다.
1. `.detach()`: 텐서에 연결된 미분 추적 기록을 분리하여 순수 숫자 데이터만 남긴다.
2. `.cpu()`: GPU 메모리에 있던 데이터를 일반 시스템 메모리(RAM)로 옮긴다.
3. `.numpy()`: 파이토치 텐서를 넘파이 배열로 변환한다.
*(참고로 인코딩 시점에 `model.encode(query, convert_to_tensor=False)` 옵션을 주면 처음부터 넘파이 배열로 받을 수도 있지만, 외부에서 이미 만들어진 텐서가 들어오더라도 함수가 깨지지 않도록 방어 코드를 둔 것이다.)*

둘째는 `np.asarray(v1, dtype=np.float32).ravel()`을 통한 **메모리 재사용과 1차원 평탄화**다. 컴퓨터에서 소수점이 있는 실수는 64비트(`float64`, 숫자당 8바이트)나 32비트(`float32`, 숫자당 4바이트)로 저장된다. 질문 벡터와 문서 행렬의 소수점 규격이 다르면 내적 연산 중에 형변환이 일어나 속도가 느려지므로, 딥러닝 임베딩의 표준 규격인 `np.float32`로 통일한다.

이때 기존 배열의 타입을 바꿀 때 흔히 쓰는 `.astype(np.float32)`나 `np.array(..., dtype=np.float32)` 대신 `np.asarray(..., dtype=np.float32)`를 쓴 이유가 있다. `.astype()`과 `np.array()`는 입력 데이터가 이미 `float32` 넘파이 배열이더라도 메모리에 무조건 새로운 복사본을 만든다. 반면 접두사 `as`(\~로서 간주하다)가 붙은 `np.asarray()`는 입력이 이미 `float32` 넘파이 배열이면 메모리를 새로 복사하지 않고 원본(Zero-copy)을 그대로 재사용하여 1만 건 이상의 벡터를 다룰 때 메모리 낭비를 막는다.

뒤에 붙은 `.ravel()`은 "실타래를 한 줄로 풀다"라는 뜻의 함수다. 질문 1개를 인코딩했을 때 모델 설정에 따라 결과가 `[1, 2, ..., 768]` 형태의 1차원 `(768,)` 배열이 아니라, `[[1, 2, ..., 768]]`처럼 겉에 대괄호가 한 겹 더 씌워진 2차원 `(1, 768)` 배열로 나오는 경우가 있다. `.ravel()`은 이처럼 불필요하게 감싸진 바깥 차원을 모두 펴서 순수한 1차원 벡터 `(768,)`로 평탄화(Flatten)한다.

셋째는 **`A.ndim`에 따른 차원 분기와 2차원 행렬 곱(`A @ v1`)**이다.
- `A.ndim == 1`인 경우: `.ndim`은 배열의 차원 수를 뜻한다. 비교 대상 `A`도 1차원 벡터 1개라면, 두 벡터의 크기 곱인 분모(`denom`)가 `0`인지 확인한 뒤 `np.dot(v1, A) / denom`으로 유사도 실수 1개를 반환한다.
- 2차원 행렬인 경우: `np.atleast_2d(A)`로 `A`가 최소 2차원 행렬(`(11314, 768)`)임을 보장한 뒤, `for`문 없이 행렬 곱 연산자 `@`를 실행한다. `A @ v1`을 실행하면 넘파이는 2차원 문서 행렬 `A`(`11314 × 768`)의 각 행(개별 문서 벡터)과 1차원 질문 벡터 `v1`(`768`)의 내적을 C언어 수준에서 병렬로 계산하여 길이 11,314짜리 분자 배열을 즉시 만든다.
- 분모 역시 `np.linalg.norm(A, axis=1)`을 사용해 행렬 `A`의 가로 방향(`axis=1`, 각 행)을 따라 11,314개 문서 벡터의 길이를 한 번에 구하고, 여기에 `v1_norm`을 곱해 길이 11,314짜리 분모 배열 `denom`을 만든다.

마지막으로 **영벡터(크기가 0인 벡터)로 인한 0 나눗셈 방어**를 수행한다. 간혹 본문이 비어 있는 문서가 섞여 있으면 벡터 크기가 `0`이 되어 분모 `denom`에 `0`이 들어간다. 이를 그냥 나누면 경고 메시지가 뜨거나 결과가 `NaN`(Not a Number)으로 깨진다. 따라서 `with np.errstate(divide='ignore', invalid='ignore'):`로 넘파이 내부 경고를 끄고, 조건 선택 함수인 `np.where(denom == 0, 1.0, denom)`을 사용해 분모 배열에서 값이 `0`인 자리만 임시로 `1.0`으로 바꿔 안전하게 나눗셈을 마친다. 그 직후 `sims[denom == 0] = 0.0`으로 원래 분모가 `0`이었던 위치의 유사도 점수를 `0.0`으로 덮어쓰고 파이썬 리스트(`.tolist()`)로 반환한다.

### 보조 함수와 정밀도·재현율 수식 구현

이어서 채점 루프에서 사용할 텍스트 전처리 함수, 순수 파이썬 기반 상위 $K$개 인덱스 추출 함수, 그리고 정밀도·재현율 계산 함수를 정의한다.

```python
def preprocess_text(text: str) -> str:
    # Remove leading and trailing whitespace and convert to lowercase
    return text.strip().lower()


def top_k_greatest_indices(lst: list, k: int) -> list[int]:
    """
    Get the indices of the top K greatest elements in a list.
    """
    indexed_list = list(enumerate(lst))
    sorted_by_value = sorted(indexed_list, key=lambda x: x[1], reverse=True)
    top_k_indices = [index for index, value in sorted_by_value[:k]]
    return top_k_indices
```

`preprocess_text`는 입력된 질문 문자열 양끝에 실수로 들어간 공백이나 줄바꿈을 `.strip()`으로 잘라내고, `.lower()`로 모든 알파벳을 소문자로 통일하여 대소문자 차이로 인한 임베딩 편차를 줄인다.

`top_k_greatest_indices(lst, k)`는 위에서 업그레이드한 `cosine_similarity`가 파이썬 리스트(`sims.tolist()`)를 반환하므로, 파이썬 기본 문법만으로 점수가 가장 큰 상위 `k`개 문서의 원래 위치 번호를 뽑아내는 함수다.
1. `list(enumerate(lst))`: 유사도 점수 리스트 `lst`(예: `[0.2, 0.9, 0.5]`)에 `enumerate`를 씌워 `[(0, 0.2), (1, 0.9), (2, 0.5)]`처럼 `(문서번호, 유사도점수)` 쌍으로 묶인 튜플 리스트를 만든다. 이렇게 문서 번호를 점수와 묶어 두어야 순서를 섞어도 원래 몇 번 문서였는지 잃어버리지 않는다.
2. `sorted(indexed_list, key=lambda x: x[1], reverse=True)`: 튜플 리스트를 정렬할 때 `key=lambda x: x[1]`을 지정한다. 여기서 `x`는 개별 튜플 `(문서번호, 유사도점수)`를 뜻하므로, `x[0]`은 문서 번호이고 `x[1]`은 유사도 점수다. 즉, 문서 번호가 아니라 두 번째 원소인 **유사도 점수(`x[1]`)**를 기준으로 삼아 큰 값부터(`reverse=True`) 내림차순 정렬하라는 뜻이다.
3. `[index for index, value in sorted_by_value[:k]]`: 정렬된 리스트에서 상위 `k`개 튜플만 잘라낸 뒤(`[:k]`), 점수는 버리고 문서 번호(`index`)만 리스트로 뽑아 반환한다.

다음으로 정밀도($\text{Precision@}K$)와 재현율($\text{Recall@}K$)을 계산하는 두 함수를 작성한다.

```python
def precision_at_k(relevant_count: int, k: int) -> float:
    """
    Compute Precision@K.
    """
    if relevant_count < 0 or k < 0:
        raise ValueError("Both relevant_count and k must be non-negative.")
    if k == 0:
        return 0.0
    return relevant_count / k


def recall_at_k(relevant_count: int, total_relevant: int) -> float:
    """
    Compute Recall@K.
    """
    if relevant_count < 0 or total_relevant < 0:
        raise ValueError("Both relevant_count and total_relevant must be non-negative.")
    if total_relevant == 0:
        return 0.0
    return relevant_count / total_relevant
```

두 함수 모두 공통 분자인 `relevant_count`(검색기가 가져온 상위 $K$개 문서 중 실제 정답 문서의 개수)를 첫 번째 인자로 받는다. `precision_at_k`는 이를 검색기가 가져온 문서 수 `k`로 나누어 **가져온 문서 중 정답의 비율**을 구하고, `recall_at_k`는 전체 데이터셋(11,314건) 안에 존재하는 해당 주제의 정답 문서 총수인 `total_relevant`로 나누어 **전체 정답 중 찾아낸 비율**을 구한다. 이때 문서 개수에 음수가 들어오면 `ValueError`를 발생시켜 잘못된 호출을 막고, 분모(`k` 또는 `total_relevant`)가 `0`일 때는 `ZeroDivisionError`를 방지하기 위해 `0.0`을 반환한다.

### 대규모 자동 채점 루프 `compute_metrics` 완성

전처리 함수와 지표 계산 함수가 준비되었으므로 테스트 질문 리스트(`queries`)를 순회하며 정밀도와 재현율을 일괄 계산하는 최종 평가 함수 `compute_metrics`를 조립한다.

```python
def compute_metrics(queries: list[dict], embeddings, model, top_k: int = 5) -> list[dict]:
    """
    Compute Precision@K and Recall@K for a list of queries.
    """
    results = []

    # Convert embeddings list to a 2D numpy array on CPU
    np_embeddings = []
    for x in embeddings:
        if hasattr(x, "detach"):
            x = x.detach().cpu().numpy()
        np_embeddings.append(np.asarray(x, dtype=np.float32).ravel())
    E = np.vstack(np_embeddings)  # shape: (N, D)

    for item in queries:
        query = preprocess_text(item["query"])
        desired_category = item["desired_category"]

        # Encode query and convert to 1D numpy vector
        q_emb = model.encode(query, convert_to_tensor=True)
        if hasattr(q_emb, "detach"):
            q_emb = q_emb.detach().cpu().numpy()
        q_emb = np.asarray(q_emb, dtype=np.float32).ravel()

        # Compute cosine similarities against full matrix E
        cos_sim = cosine_similarity(q_emb, E)
        top_results = top_k_greatest_indices(cos_sim, k=top_k)

        # Map retrieved indices to category names
        retrieved_categories = [
            newsgroups_train.target_names[df.iloc[idx]["category"]] for idx in top_results
        ]

        relevant_in_top_k = sum(
            1 for cat in retrieved_categories if cat == desired_category
        )
        total_relevant_in_corpus = sum(
            1 for idx in range(len(df))
            if newsgroups_train.target_names[df.iloc[idx]["category"]] == desired_category
        )

        # Compute Precision@K and Recall@K
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

이 함수의 세 가지 내부 동작을 순서대로 살펴본다.

첫째는 질문 루프에 들어가기 전에 실행하는 **`E = np.vstack(np_embeddings)`**다. 파일에서 불러온 `embeddings`를 순회하며 `.ravel()`로 1차원 `(768,)` 벡터로 맞춘 `np_embeddings`는 11,314개의 벡터가 낱개로 들어 있는 파이썬 리스트다. 파이썬 리스트는 각 원소가 메모리 곳곳에 흩어져 있어 행렬 곱을 수행할 수 없다. `np.vstack`은 **V**ertical **Stack**(수직으로 쌓기)의 약자로, 길이 768짜리 1차원 벡터 11,314개를 위에서 아래로 층층이 쌓아 올려 **세로 11,314행 × 가로 768열(`(11314, 768)`) 크기의 단일 2차원 넘파이 행렬 `E`(`Embeddings`의 약자)**로 합쳐 준다. 이렇게 루프 밖에서 2차원 행렬 `E`를 한 번만 만들어 두면, 아래쪽 질문 루프에서 `cosine_similarity(q_emb, E)`를 호출할 때마다 `E @ q_emb` 행렬 곱이 작동하여 11,314개 문서와의 유사도가 동시에 계산된다.

둘째는 검색기가 뽑아온 상위 문서 번호들을 실제 카테고리 문자열로 바꾸는 **`retrieved_categories`** 리스트 컴프리헨션이다.

```python
retrieved_categories = [
    newsgroups_train.target_names[df.iloc[idx]["category"]] for idx in top_results
]
```

이 코드는 안쪽 대괄호부터 바깥쪽 순서로 계산된다.
1. `for idx in top_results`: 상위 $K$개 문서의 행 번호(예: `idx = 412`)를 하나씩 꺼낸다.
2. `df.iloc[idx]["category"]`: 판다스의 `df.iloc`는 **I**nteger **loc**ation(정수 위치)의 약자로, 표에 설정된 별도의 인덱스 라벨(`df.loc`)과 상관없이 무조건 위에서부터 `0, 1, 2, ...` 순서로 매겨진 정수 행 번호(`idx`)로 데이터를 조회한다. 즉, 표 `df`의 `412`번 행에서 `"category"` 열의 숫자(예: `14`)를 꺼낸다.
3. `newsgroups_train.target_names[14]`: 방금 꺼낸 카테고리 번호 `14`를 전체 주제 이름 리스트에 대입하여 `'sci.space'`라는 실제 카테고리 문자열로 변환한다. 그 결과 `retrieved_categories`에는 `['sci.space', 'sci.space', 'comp.graphics', ...]`처럼 상위 $K$개 문서의 주제 이름들이 담긴다.

셋째는 정답 문서 개수를 세는 **`sum(1 for ... if ...)`** 문법이다.
- **`relevant_in_top_k` (공통 분자)**: `sum(1 for cat in retrieved_categories if cat == desired_category)`는 방금 구한 상위 $K$개 문서의 카테고리(`cat`)를 하나씩 확인하면서, 질문이 요구한 정답 카테고리(`desired_category`)와 일치할 때마다 숫자 `1`을 발생시켜 모두 더한다. 즉, 상위 $K$개 안에 들어 있는 정답 문서의 개수를 센다.
- **`total_relevant_in_corpus` (재현율의 분모)**: `range(len(df))`를 통해 `0`번부터 `11313`번까지 전체 11,314개 문서를 전수 조사하면서, 카테고리가 `desired_category`와 일치하는 문서가 나올 때마다 `1`을 더해 데이터셋 전체에 존재하는 정답 문서의 총개수(약 500\~600건)를 구한다.

이렇게 구한 분자와 분모를 `precision_at_k`와 `recall_at_k`에 넣어 점수를 계산하고, 결과 딕셔너리를 `results` 리스트에 담아 반환한다.

마지막으로 11개의 테스트 질문(`test_queries`)과 세 가지 조회 개수(`k_values = [5, 20, 50]`)를 설정하여 전체 평가 루프를 실행한다.

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

코드를 실행하면 각 질문과 $K$값에 대한 정밀도·재현율 계산 결과가 출력된다.

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

출력된 결과를 통해 이전 이론 편에서 다루었던 두 가지 핵심 현상을 코드로 직접 검증할 수 있다. 첫째, 우주 과학(`sci.space`, 전체 정답 593건) 질문에서 5개를 뽑아 5개 모두 정답을 맞히더라도(`Precision@5 = 1.00`), 분모가 593건이므로 `Recall@5`는 `5 / 593 = 0.01`(1%)에 머문다. 이후 $K$를 20, 50으로 늘리면 재현율은 `0.03`(20/593), `0.08`(46/593)로 상승하는 반면 정밀도는 `0.92`(46/50)로 소폭 하락한다. 둘째, `"global conflict economy crisis intervention"`처럼 여러 분야에 걸친 모호한 질문은 임베딩 공간에서 외교·종교 문서들과 가깝게 뭉쳐 있어 $K=5$에서도 정밀도가 `0.20`(1/5)에 그치며, 이러한 질의에서 키워드 검색(BM25)과 RRF 결합이 왜 필수적인지를 수치로 뒷받침해 준다.

---

## 6. 참고 자료

- DeepLearning.AI — *Retrieval Augmented Generation (RAG)*, Module 2: "Information Retrieval Foundations" (Instructor: Zain Hasan, Andrew Ng)
