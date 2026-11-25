---
title: "RAG 파이프라인 1편: RAG 구조와 프롬프트 조립"
description: "사전학습 언어 모델의 지식 한계와 환각 원인을 살펴보고, 검색기와 지식 베이스를 결합한 RAG 기본 아키텍처와 프롬프트 조립 과정을 정리한다."
pubDate: "2026-10-26 16:15:00"
tags: ["RAG", "LLM", "InformationRetrieval", "PromptEngineering", "Python"]
categories: ["Architecture", "AI"]
draft: false
---

## 1. 사전학습 LLM의 한계

대규모 언어 모델(LLM)의 가중치는 사전 학습(Pre-training)이 끝나는 시점에 고정된다. 따라서 인터넷에 널리 알려진 일반적인 지식은 잘 설명하지만, 학습 이후에 일어난 최신 사건이나 비공개 문서, 혹은 온라인에서 찾기 어려운 세부 정보에는 제대로 답하지 못한다.

예를 들어 `"주말에 호텔 요금이 왜 비싼가?"`라는 일반적인 질문에는 주말에 여행객이 몰려 객실 경쟁이 치열해진다는 상식적인 답을 내놓는다. 하지만 `"이번 주말 밴쿠버 호텔 요금이 왜 유독 비싼가?"`(테일러 스위프트의 밴쿠버 콘서트 일정) 같은 최신 정보는 알지 못한다. `"왜 밴쿠버 도심 근처에는 호텔 객실 수용량이 부족한가?"`(1900년대 초부터 이어진 밴쿠버 도시계획 및 구역 법규)처럼 인터넷에 잘 드러나지 않는 지역 행정 문서 역시 모델이 답하기 어렵다.

![사전 학습 데이터와 전문 및 지역 지식의 격차](/images/rag/module1/llm_knowledge_limits.png)

새로운 정보가 생길 때마다 수십억 개의 모델 파라미터를 다시 학습시키는 것은 시간과 비용이 많이 든다. 또한 언어 모델은 모르는 질문을 받았을 때 모른다고 답하는 대신 그럴듯한 거짓 정보를 지어내는 **환각(Hallucination)** 현상을 보인다.

그 이유는 언어 모델이 문장의 사실 여부를 확인하는 도구가 아니라, 지금까지 입력된 단어들 뒤에 이어질 **다음 토큰(단어 조각)의 확률을 계산해 이어 붙이는 자동완성 모델**이기 때문이다.

![언어 모델의 어휘 사전 기반 다음 토큰 확률 계산](/images/rag/module1/llm_next_token_prob.png)

위 그림처럼 `"What a beautiful day, the sun is"`라는 문장이 들어오면, 모델은 수만 개의 어휘 사전(Vocabulary)에서 다음에 올 법한 토큰들의 확률을 계산한다. 문맥상 자연스러운 `shining`(`80%`)이나 `rising`(`5%`), `out`(`4%`)은 높은 확률을 받고, `exploding`(`0.00002%`)이나 `snoring`(`0.00001%`)은 매우 낮은 확률을 받는다. 모델은 이 확률 분포에 따라 다음 단어를 하나씩 골라 문장을 이어 나간다. 언어 모델은 **'사실인 문장(Truthful)'이 아니라 '통계적으로 그럴듯한 문장(Probable)'을 생성하도록 설계**된다. 따라서 학습 데이터에 없는 질문을 받아도 그럴듯하게 들리는 오답을 만들어 낸다.

이 문제를 해결하기 위해 모델 가중치를 고치는 대신 외부 문서를 활용한다. 질문과 관련된 문서를 찾아 프롬프트 안에 직접 넣어주는 **검색 증강 생성(Retrieval-Augmented Generation, RAG)** 구조다.

![일반 LLM 호출과 RAG 파이프라인의 동작 비교](/images/rag/module1/rag_overview.png)

RAG 시스템은 언어 모델 앞단에 신뢰할 수 있는 문서를 모아둔 **지식 베이스(Knowledge Base)**와, 질문에 맞는 문서를 찾아내는 **검색기(Retriever)**를 둔다. 사용자가 질문을 입력하면 검색기가 지식 베이스에서 관련 기사나 문서를 먼저 찾아내고, 이를 원래 질문과 합쳐 **증강 프롬프트(Augmented Prompt)**를 만든 뒤 언어 모델에 넘긴다. 언어 모델은 프롬프트에 함께 들어온 참고 문서를 근거로 삼아(Grounding) 정확한 답변을 작성한다. 또한 지식이 바뀌더라도 모델을 다시 학습할 필요 없이 지식 베이스의 문서만 갱신하면 최신 정보가 바로 반영되며, 답변에 사용한 원본 문서의 출처(Citation)를 함께 제시할 수도 있다.

여기서 `"그렇다면 지식 베이스에 있는 모든 문서를 프롬프트에 한꺼번에 다 넣으면 되지 않는가?"`라는 의문이 생길 수 있다. 하지만 두 가지 이유로 모든 문서를 다 넣을 수는 없다.

![지식 베이스 전체를 프롬프트에 넣을 수 없는 이유](/images/rag/module1/why_not_add_everything.png)

1. **연산 비용과 응답 시간 증가 (`Higher Computational Cost`)**: 언어 모델은 새로운 토큰을 하나 생성할 때마다 프롬프트에 들어 있는 모든 토큰을 처음부터 다시 스캔(Self-Attention 연산)한다. 따라서 프롬프트가 길어질수록 토큰 하나를 만드는 계산량이 크게 늘어나 응답 속도가 느려지고 API 호출 비용도 비싸진다.
2. **컨텍스트 윈도우 한계 (`Context Window Limit`)**: 모든 언어 모델은 한 번에 입력받을 수 있는 최대 토큰 수(Context Window)가 정해져 있다. 작은 모델은 수천 토큰, 큰 모델도 일정 한도가 있으므로 수만 건의 문서를 통째로 넣으면 입력 한도를 넘기게 된다.

결국 전체 문서를 다 넣는 대신, 질문과 직접 관련된 소수의 문서만 골라 프롬프트에 넣어주는 검색기(Retriever)가 꼭 필요하다.

---

## 2. 검색기와 데이터 흐름

사용자 눈에는 RAG 시스템도 질문을 넣고 답변을 받는 일반 챗봇과 같아 보인다. 하지만 내부에서는 **질문 입력 ➔ 지식 베이스 검색 ➔ 증강 프롬프트 조립 ➔ 모델 답변 생성**의 네 단계가 차례대로 실행된다.

검색기의 역할은 도서관의 주제별 색인 탐색기(Index Catalog)와 같다. 도서관에 수많은 책이 분야별로 정리되어 있듯, 지식 베이스의 문서들도 검색하기 좋게 색인(Index)으로 정리되어 있다. 검색기는 두 가지 질문을 중심으로 동작한다. 첫째는 `"사용자의 질문이 무엇을 의미하는가?"`이고, 둘째는 `"지식 베이스의 문서 중 어떤 문서가 이 질문과 가장 비슷한가?"`이다.

![검색기의 문서 관련도 점수 계산과 상위 문서 선별](/images/rag/module1/retriever_scoring.png)

위 그림처럼 사용자가 `"집에서 뉴욕 스타일 피자를 어떻게 만드는가?(How can I make New York style pizza at home?)"`라고 질문하면, 검색기는 지식 베이스의 문서들과 질문 사이의 유사도 점수를 계산한다. 피자 기본 레시피(`Pizza Basics`)는 `0.95`점, 홈쿠킹 가이드(`Cooking at Home`)는 `0.8`점, 소스 비법(`Sauce Secrets`)은 `0.7`점을 받는다. 뉴욕시의 역사(`A History of NYC`)는 `'NYC'`라는 단어만 겹치므로 `0.6`점에 머문다. 검색기는 점수가 높은 상위 문서들을 골라 언어 모델에 전달한다.

이때 몇 개의 문서를 프롬프트에 넘길지(`top_k`) 정할 때는 양면성을 고려해야 한다. 가져오는 문서 수를 너무 많이 늘리면 관련 없는 문서가 섞여 들어가 컨텍스트 윈도우를 낭비하고 응답 품질을 떨어뜨린다. 반대로 1위 문서 단 한 개만 가져오면, 검색기가 항상 정답 문서만 맨 위에 두지는 못하므로 2\~3위 문서에 들어 있는 중요한 정보를 놓칠 수 있다. 따라서 시스템에 맞게 `top_k`(예: 3\~5개)를 조절하며 실험해야 한다.

이 검색과 생성의 결합 과정을 파이썬 코드로 나타내면 세 단계 함수 호출로 정리된다.

```python
# 아래 코드는 2절의 전체 데이터 흐름을 보여 주는 개념 예시이며, 실제 실행 코드는 4절에서 단계별로 구현한다.
def rag_pipeline(query: str, top_k: int = 3) -> str:
    # 1. 지식 베이스에서 질의와 연관성이 높은 문서 검색
    retrieved_docs = retrieve(query, top_k=top_k)

    # 2. 검색된 문서와 사용자 질의를 결합하여 증강 프롬프트 조립
    context_text = "\n".join(retrieved_docs)
    augmented_prompt = (
        f"다음 제공된 문맥을 바탕으로 질문에 사실에 입각하여 답하라.\n\n"
        f"[참고 문맥]\n{context_text}\n\n"
        f"[사용자 질문]\n{query}"
    )

    # 3. 문맥이 주입된 완성 프롬프트를 언어 모델에 전달하여 응답 생성
    response = generate(augmented_prompt)
    return response
```

먼저 검색 단계(`retrieve`)에서는 지식 베이스를 탐색해 질의와 가장 연관도가 높은 $k$개의 텍스트 조각을 리스트 형태로 반환한다. 이어지는 조립 단계에서는 이 문서들을 줄바꿈(`\n`)으로 연결해 `[참고 문맥]` 구분자 안에 배치하고, 원본 질의와 결합하여 단일 프롬프트 문자열로 완성한다. 마지막으로 생성 단계(`generate`)가 완성된 프롬프트를 언어 모델 API 엔드포인트로 전송한다. 이처럼 검색기가 사실 확인과 데이터 필터링을 전담함으로써, 언어 모델은 전체 데이터에서 정보를 직접 탐색하는 대신 주어진 문맥을 종합해 자연스러운 문장으로 서술하는 본래 역할에 집중할 수 있다.

---

## 3. 증강 프롬프트 조립

지식 베이스나 데이터베이스에서 검색된 결과는 대개 파이썬 딕셔너리(`dict`)나 테이블의 레코드 형태를 띤다. 이 원시 객체를 `str(dict)` 형태로 프롬프트에 그대로 넣으면 문제가 발생한다. 중괄호와 따옴표 같은 구문 기호가 불필요하게 토큰을 소비한다. 또한 필드 경계가 불명확해 모델이 수치나 속성을 혼동하기 쉽다. 따라서 모델이 읽기 편한 자연어 문장 구조로 데이터를 변환해야 한다.

아래 코드는 딕셔너리 형태의 부동산 매물 샘플을 서술형 문장으로 가공하고, 이를 프롬프트 템플릿에 결합하는 과정을 보여준다.

```python
houses = [
    {
        "address": "742 Evergreen Terrace",
        "city": "Springfield",
        "state": "OR",
        "zip": "97477",
        "bedrooms": 3,
        "bathrooms": 2,
        "square_feet": 1500,
        "price": 230000,
        "year_built": 1995,
    },
    {
        "address": "108 Maple Avenue",
        "city": "Shelbyville",
        "state": "OR",
        "zip": "97478",
        "bedrooms": 4,
        "bathrooms": 3,
        "square_feet": 2500,
        "price": 320000,
        "year_built": 2008,
    },
]

# 딕셔너리 레코드를 한 줄짜리 서술형 문장으로 풀기 위해 각 속성을 연결한다.
def house_info_layout(houses: list[dict]) -> str:
    layout = ""
    for house in houses:
        layout += (
            f"House located at {house['address']}, {house['city']}, {house['state']} {house['zip']} with "
            f"{house['bedrooms']} bedrooms, {house['bathrooms']} bathrooms, "
            f"{house['square_feet']} sq ft area, priced at ${house['price']}, "
            f"built in {house['year_built']}.\n"
        )
    return layout

# 지시문, 문맥 데이터, 질문을 별도 구획으로 나누어 프롬프트 혼선을 막는다.
def generate_prompt(query: str, houses: list[dict]) -> str:
    houses_layout = house_info_layout(houses)
    prompt = f"""Use the following houses information to answer users queries.
{houses_layout}
Query: {query}"""
    return prompt
```

원시 매물 데이터를 문장으로 가공할 때는(`house_info_layout`) 딕셔너리를 순회하며 주소, 방 개수, 면적, 가격을 한 줄의 설명 문장으로 정리한다. 각 매물 정보는 줄바꿈(`\n`)으로 구분하여 모델이 개별 레코드를 독립된 단위로 인식하게 만든다. 이어서 프롬프트 조립 함수(`generate_prompt`)는 가공된 텍스트(`houses_layout`)를 지시문 아래에 배치하고 맨 마지막에 사용자의 `Query`를 덧붙인다. 지시문과 문맥, 질문이 명확한 구획으로 나뉘어 있어 모델이 어떤 데이터를 참고해 무엇에 답해야 하는지 바로 파악할 수 있다.

이렇게 문맥을 주입했을 때와 주입하지 않았을 때의 모델 출력 차이는 분명하다. "가장 비싼 집과 가장 넓은 집은 어디인가?"라는 질문을 단독으로 보냈을 때, 모델은 해당 매물에 대한 정보가 없으므로 집을 고르는 일반적인 기준만 설명한다. 반면 가공된 매물 문맥을 함께 전달하면 모델이 실제 수치를 대조하기 시작한다. Shelbyville 소재 주택(\$320,000, 2,500 sq ft)과 Springfield 소재 주택(\$230,000, 1,500 sq ft)을 정확히 비교해 정답을 찾아낸다. 정형화된 프롬프트 템플릿으로 데이터를 주입하는 작업이 모델의 환각을 줄이는 기본 검증 수단이 된다.

---

## 4. 뉴스 RAG 파이프라인

### 벡터 유사도 검색과 기사 조회 내부 구조

단순 텍스트 매칭만으로는 질문의 의도와 문서의 의미적 연관성을 정밀하게 파악하기 어렵다. 따라서 현대 검색기는 문장을 고차원 수치 벡터로 변환하는 임베딩 모델과 벡터 간 유사도 연산을 활용한다.

이 파이프라인에서는 2024년 뉴스 데이터셋(`news_data_dedup.csv`)을 지식 베이스로 사용한다. 검색 함수를 실행하기 전에 임베딩 모델(`model`), 기사 텍스트 목록(`NEWS_DATA`), 그리고 미리 계산해 둔 기사 임베딩 행렬(`EMBEDDINGS`)을 준비해야 한다.

```python
import joblib
import numpy as np
import pandas as pd
from sentence_transformers import SentenceTransformer
from sklearn.metrics.pairwise import cosine_similarity

# 임베딩 모델, 뉴스 레코드 목록, 사전 계산 임베딩(.joblib 직렬화 파일)을 메모리에 올린다.
model = SentenceTransformer("BAAI/bge-base-en-v1.5")
NEWS_DATA = pd.read_csv("news_data_dedup.csv").to_dict("records")
EMBEDDINGS = joblib.load("embeddings.joblib")
# NEWS_DATA[0] 예시: {'title': '...', 'description': '...', 'published_at': '2024-04-...', 'url': 'https://...'}

# 질문 임베딩을 2차원 행렬로 맞추어 전체 기사 임베딩과 한 번에 유사도를 계산한다.
def retrieve(query: str, top_k: int = 5) -> np.ndarray:
    # 가변 길이 질문 문장을 768차원 밀집 벡터(1차원 배열)로 변환
    query_embedding = model.encode(query)

    # cosine_similarity는 (샘플 수, 차원) 2차원 입력을 요구하므로 reshape(1, -1)로 감싸고, [0]으로 1차원 점수 배열을 꺼낸다.
    similarity_scores = cosine_similarity(query_embedding.reshape(1, -1), EMBEDDINGS)[0]

    # 부호를 뒤집어 내림차순으로 정렬한 뒤, 원래 기사의 행 번호만 상위 top_k개 추린다.
    similarity_indices = np.argsort(-similarity_scores)
    top_k_indices = similarity_indices[:top_k]

    return top_k_indices

# 추출한 행 인덱스(list[int] 또는 np.ndarray) 목록으로 실제 기사 딕셔너리 레코드를 꺼낸다.
def query_news(indices: list[int] | np.ndarray) -> list[dict]:
    output = [NEWS_DATA[index] for index in indices]
    return output

# 검색(인덱스 추출)과 레코드 조회를 하나의 호출로 묶는다.
def get_relevant_data(query: str, top_k: int = 5) -> list[dict]:
    relevant_indices = retrieve(query=query, top_k=top_k)
    relevant_data = query_news(relevant_indices)
    return relevant_data
```

벡터 검색 단계에서는 먼저 임베딩 모델(`model.encode()`)로 가변 길이 질문 텍스트를 768차원의 밀집 벡터로 바꾼다. `cosine_similarity` 함수는 2차원 행렬 쌍을 입력으로 받기 때문에 `reshape(1, -1)`로 1행짜리 2차원 배열 모양을 맞추고, 반환된 `(1, 기사 수)` 행렬에서 `[0]`으로 1차원 점수 목록을 꺼낸다.

유사도를 잴 때는 유클리드 거리 대신 벡터의 크기 차이를 정규화해 방향의 일치도($-1 \sim 1$)만 비교하는 코사인 유사도를 쓴다. 문서 길이에 따른 벡터 크기 왜곡을 막아 주기 때문이며, 구체적인 거리 비교 수식과 행렬 계산 원리는 다음 2편에서 자세히 다룬다.

점수 배열이 나오면 `np.argsort(-similarity_scores)`로 내림차순 정렬된 원래 기사 행 번호만 얻는다. 점수 값 자체가 아니라 원본 기사 번호가 필요하기 때문이다. 마지막으로 `query_news()`가 상위 `top_k`개의 인덱스로 메모리의 기사 딕셔너리를 꺼내고, `get_relevant_data()`가 두 단계를 묶어 최적의 기사 레코드 목록을 돌려준다.

### 검색 기사 정리와 프롬프트 조립

검색된 기사 레코드는 제목, 본문 요약, 발행일, 출처 URL 필드를 포함하는 딕셔너리 구조다. 모델이 문맥을 정확히 파악할 수 있도록 각 속성을 명확한 줄바꿈 텍스트로 정리해야 한다.

또한 파이프라인에서는 RAG 적용 여부를 선택할 수 있어야 한다. 아래 코드는 검색된 기사들을 하나의 텍스트 블록으로 정리하고, 증강 프롬프트 템플릿과 결합하는 로직을 보여준다.

```python
# 1. 검색된 기사 딕셔너리 리스트를 줄바꿈 텍스트로 변환
def format_relevant_data(relevant_data: list[dict]) -> str:
    formatted_documents = []
    for document in relevant_data:
        formatted_document = (
            f"Title: {document['title']}, "
            f"Description: {document['description']}, "
            f"Published at: {document['published_at']}\n"
            f"URL: {document['url']}"
        )
        formatted_documents.append(formatted_document)
    return "\n".join(formatted_documents)

# 2. RAG 활성화 여부에 따른 프롬프트 분기 조립
def generate_final_prompt(query: str, top_k: int = 5, use_rag: bool = True, prompt: str = None) -> str:
    # RAG 비활성화 모드(use_rag=False)에서는 검색 없이 원본 질문만 그대로 반환한다.
    if not use_rag:
        return query

    # 상위 k개 기사 검색 및 텍스트 정리
    relevant_data = get_relevant_data(query, top_k=top_k)
    retrieve_data_formatted = format_relevant_data(relevant_data)

    # 별도 템플릿이 없으면(prompt is None) 제공된 맥락이 2024년 최신 뉴스임을 명시하는 기본 프롬프트를 사용한다.
    if prompt is None:
        prompt = (
            f"Answer the user query below. There will be provided additional information for you to compose your answer. "
            f"The relevant information provided is from 2024 and it should be added as your overall knowledge to answer the query, "
            f"you should not rely only on this information to answer the query, but add it to your overall knowledge.\n"
            f"Query: {query}\n"
            f"2024 News: {retrieve_data_formatted}"
        )
    else:
        # 외부에서 사용자 지정 프롬프트 템플릿을 넘긴 경우 {query}와 {documents} 자리표시자만 채워 사용한다.
        prompt = prompt.format(query=query, documents=retrieve_data_formatted)

    return prompt
```

검색된 기사를 프롬프트용 텍스트로 정리하는 단계(`format_relevant_data`)에서는 제목(`title`), 요약(`description`), 발행일(`published_at`), 출처(`url`)를 꺼내 줄바꿈(`\n`)으로 묶는다.

최종 프롬프트 조립 함수(`generate_final_prompt`)는 `use_rag` 플래그로 RAG 동작을 끄고 켠다. `use_rag=False`이면 검색을 건너뛰고 원본 질의만 반환한다. `use_rag=True`이면 검색과 문자열 정리를 순서대로 호출해 기사 문맥을 만들고, 사용자 지정 `prompt` 템플릿이 있으면 `{query}`와 `{documents}` 자리를 채운다. 기본 템플릿은 제공된 문맥이 2024년 최신 정보임을 명시해 모델이 발행 시점을 오인하지 않도록 돕는다.

### 모델 호출과 최신 뉴스 답변 비교

증강 프롬프트가 완성되면 이를 언어 모델 API 엔드포인트에 전달하여 최종 답변을 생성한다. 여기서 `generate_with_single_input()`은 단일 프롬프트 문자열을 받아 언어 모델 API를 호출하고 응답 딕셔너리를 돌려주는 공용 래퍼 함수다.

```python
from utils import generate_with_single_input

# 검색, 프롬프트 조립, LLM 생성을 하나의 종단간 흐름으로 묶는다.
def llm_call(query: str, top_k: int = 5, use_rag: bool = True, prompt: str = None) -> str:
    # RAG 사용 여부에 따라 일반 질의 또는 기사가 포함된 증강 프롬프트를 준비
    final_prompt = generate_final_prompt(query, top_k=top_k, use_rag=use_rag, prompt=prompt)

    # Together AI의 Qwen/Qwen3.5-9B 모델을 단일 프롬프트 래퍼로 호출
    generated_response = generate_with_single_input(final_prompt)

    # 응답 딕셔너리에서 생성된 텍스트 본문만 꺼낸다.
    generated_message = generated_response['content']
    return generated_message
```

종단간 호출 함수(`llm_call`)는 먼저 `generate_final_prompt()`로 완성된 프롬프트를 만든다. 이어서 `generate_with_single_input()`을 통해 Together AI의 Qwen 9B 모델 API로 프롬프트를 보내고 생성 결과 문자열만 꺼내 반환한다.

이 파이프라인에 최신 경제 질의인 `"Tell me about the US GDP in the past 3 years."`(최근 3년간 미국 GDP 현황에 대해 알려달라)를 입력하여 RAG 적용 여부에 따른 출력 차이를 비교한다.

먼저 RAG를 적용하지 않은 경우(`use_rag=False`), 모델은 사전 학습 데이터에 포함된 2021\~2023년 과거 지식만 참조한다. 2024년 1분기 경제 성장률이나 최신 IMF 전망치는 알지 못하므로, 과거 일반론을 서술하거나 최근 상황에 대해 불확실한 추측을 내놓는다.

반면 RAG를 적용한 경우(`use_rag=True`), 검색기는 2024년 4월 월스트리트저널(WSJ) 기사들을 프롬프트에 주입한다. 검색된 기사에는 올해 미국이 전 세계 GDP의 26.3%를 차지해 20년 만에 최고치를 기록할 것이라는 IMF 전망이 담겨 있다. 또한 2024년 1분기 미국 GDP 성장률이 연율 1.6%로 집계되었다는 최신 수치도 포함되어 있다. 모델은 주입된 문맥을 바탕으로 2024년 4월 시점의 구체적인 경제 지표를 인용한 정확한 답변을 생성한다.

이처럼 검색기를 결합한 RAG 아키텍처는 모델의 고정된 사전학습 가중치를 재학습하지 않고도, 외부 지식 베이스의 최신 사실을 프롬프트 문맥으로 실시간 공급하여 신뢰성 높은 답변을 완성한다. 또한 프롬프트에 포함된 기사 발행일과 출처 URL은 단순한 배경 정보에 그치지 않는다. 모델이 문맥을 인용해 답변할 때 출처(Citation)를 함께 명시하도록 유도할 수 있다. 이를 통해 사용자는 모델의 출력을 맹신하지 않고 원본 문서를 직접 대조하여 사실 여부를 교차 검증할 수 있다.

---

## 5. 참고 자료

1. **DeepLearning.AI** — *Retrieval Augmented Generation (RAG)*, Module 1: "Introduction to RAG Systems" (Instructor: Zain Hasan, Andrew Ng)
