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

예를 들어 `"주말에 호텔 요금이 왜 비싼가?"`라는 일반적인 질문에는 주말에 여행객이 몰려 객실 경쟁이 치열해진다는 상식적인 답을 내놓는다. 하지만 `"이번 주말 밴쿠버 호텔 요금이 왜 유독 비싼가?"`(테일러 스위프트의 밴쿠버 콘서트 일정) 같은 최신 정보나, `"왜 밴쿠버 도심 근처에는 호텔 객실 수용량이 부족한가?"`(1900년대 초부터 이어진 밴쿠버 도시계획 및 구역 법규)처럼 인터넷에 잘 드러나지 않는 지역 행정 문서는 모델이 알기 어렵다.

![사전 학습 데이터와 전문·지역 지식의 격차](/images/rag/module1/llm_knowledge_limits.png)

새로운 정보가 생길 때마다 수십억 개의 모델 파라미터를 다시 학습시키는 것은 시간과 비용이 많이 든다. 또한 언어 모델은 모르는 질문을 받았을 때 모른다고 답하는 대신 그럴듯한 거짓 정보를 지어내는 **환각(Hallucination)** 현상을 보인다.

그 이유는 언어 모델이 문장의 사실 여부를 확인하는 도구가 아니라, 지금까지 입력된 단어들 뒤에 이어질 **다음 토큰(단어 조각)의 확률을 계산해 이어 붙이는 자동완성 모델**이기 때문이다.

![언어 모델의 어휘 사전 기반 다음 토큰 확률 계산](/images/rag/module1/llm_next_token_prob.png)

위 슬라이드처럼 `"What a beautiful day, the sun is"`라는 문장이 들어오면, 모델은 수만 개의 어휘 사전(Vocabulary)에서 다음에 올 법한 토큰들의 확률을 계산한다. 문맥상 자연스러운 `shining`(`80%`)이나 `rising`(`5%`), `out`(`4%`)은 높은 확률을 받고, `exploding`(`0.00002%`)이나 `snoring`(`0.00001%`)은 매우 낮은 확률을 받는다. 모델은 이 확률 분포에 따라 다음 단어를 하나씩 골라 문장을 이어 나간다. 즉, 언어 모델은 **'사실인 문장(Truthful)'이 아니라 '통계적으로 그럴듯한 문장(Probable)'을 생성하도록 설계**되어 있어서, 학습 데이터에 없는 질문을 받아도 그럴듯하게 들리는 오답을 만들어 낸다.

이 문제를 해결하기 위해 모델 가중치를 고치는 대신, 질문과 관련된 외부 문서를 찾아 프롬프트 안에 직접 넣어주는 **검색 증강 생성(Retrieval-Augmented Generation, RAG)** 구조를 사용한다.

![일반 LLM 호출과 RAG 파이프라인의 동작 비교](/images/rag/module1/rag_overview.png)

RAG 시스템은 언어 모델 앞단에 신뢰할 수 있는 문서를 모아둔 **지식 베이스(Knowledge Base)**와, 질문에 맞는 문서를 찾아내는 **검색기(Retriever)**를 둔다. 사용자가 질문을 입력하면 검색기가 지식 베이스에서 관련 기사나 문서를 먼저 찾아내고, 이를 원래 질문과 합쳐 **증강 프롬프트(Augmented Prompt)**를 만든 뒤 언어 모델에 넘긴다. 언어 모델은 프롬프트에 함께 들어온 참고 문서를 근거로 삼아(Grounding) 정확한 답변을 작성한다. 또한 지식이 바뀌더라도 모델을 다시 학습할 필요 없이 지식 베이스의 문서만 갱신하면 최신 정보가 바로 반영되며, 답변에 사용한 원본 문서의 출처(Citation)를 함께 제시할 수도 있다.

여기서 `"그렇다면 지식 베이스에 있는 모든 문서를 프롬프트에 한꺼번에 다 넣으면 되지 않는가?"`라는 의문이 생길 수 있다. 하지만 두 가지 이유로 모든 문서를 다 넣을 수는 없다.

![지식 베이스 전체를 프롬프트에 넣을 수 없는 이유](/images/rag/module1/why_not_add_everything.png)

1. **연산 비용과 응답 시간 증가 (`Higher Computational Cost`)**: 언어 모델은 새로운 토큰을 하나 생성할 때마다 프롬프트에 들어 있는 모든 토큰을 처음부터 다시 스캔(Self-Attention 연산)한다. 따라서 프롬프트가 길어질수록 토큰 하나를 만드는 계산량이 크게 늘어나 응답 속도가 느려지고 API 호출 비용도 비싸진다.
2. **컨텍스트 윈도우 한계 (`Context Window Limit`)**: 모든 언어 모델은 한 번에 입력받을 수 있는 최대 토큰 수(Context Window)가 정해져 있다. 작은 모델은 수천 토큰, 큰 모델도 일정 한도가 있으므로 수만 건의 문서를 통째로 넣으면 입력 한도를 넘기게 된다.

결국 전체 문서를 다 넣는 대신, 질문과 직접 관련된 소수의 문서만 골라 프롬프트에 넣어주는 검색기(Retriever)가 꼭 필요하다.

---

## 2. 검색기 결합과 데이터 흐름

사용자 눈에는 RAG 시스템도 질문을 넣고 답변을 받는 일반 챗봇과 같아 보인다. 하지만 내부에서는 **질문 입력 ➔ 지식 베이스 검색 ➔ 증강 프롬프트 조립 ➔ 모델 답변 생성**의 네 단계가 차례대로 실행된다.

검색기의 역할은 도서관 사서와 비슷하다. 도서관에 수많은 책이 분야별로 정리되어 있듯, 지식 베이스의 문서들도 검색하기 좋게 색인(Index)으로 정리되어 있다. 검색기는 두 가지 질문을 중심으로 동작한다. 첫째는 `"사용자의 질문이 무엇을 의미하는가?"`이고, 둘째는 `"지식 베이스의 문서 중 어떤 문서가 이 질문과 가장 비슷한가?"`이다.

![검색기의 문서 관련도 점수 계산과 상위 문서 선별](/images/rag/module1/retriever_scoring.png)

위 슬라이드처럼 사용자가 `"집에서 뉴욕 스타일 피자를 어떻게 만드는가?(How can I make New York style pizza at home?)"`라고 질문하면, 검색기는 지식 베이스의 문서들과 질문 사이의 유사도 점수를 계산한다. 피자 기본 레시피(`Pizza Basics`)는 `0.95`점, 홈쿠킹 가이드(`Cooking at Home`)는 `0.8`점, 소스 비법(`Sauce Secrets`)은 `0.7`점, 뉴욕시의 역사(`A History of NYC`)는 `'NYC'`라는 단어만 겹치므로 `0.6`점을 받는다. 검색기는 점수가 높은 상위 문서들을 골라 언어 모델에 전달한다.

이때 몇 개의 문서를 프롬프트에 넘길지(`top_k`) 정할 때는 양면성을 고려해야 한다. 가져오는 문서 수를 너무 많이 늘리면 관련 없는 문서가 섞여 들어가 컨텍스트 윈도우를 낭비하고 응답 품질을 떨어뜨린다. 반대로 1위 문서 단 한 개만 가져오면, 검색기가 항상 완벽하게 순위를 매기지는 못하므로 2\~3위 문서에 들어 있는 중요한 정보를 놓칠 수 있다. 따라서 시스템에 맞게 `top_k`(예: 3\~5개)를 조절하며 실험해야 한다.

이 검색과 생성의 결합 과정을 파이썬 코드로 나타내면 세 단계 함수 호출로 정리된다.

```python
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

`retrieve()` 함수는 지식 베이스를 탐색해 질의와 가장 연관도가 높은 $k$개의 텍스트 조각을 리스트 형태로 반환한다. 컨트롤러 계층에서는 이 문서들을 줄바꿈(`\n`)으로 연결해 명시적인 문맥 구분자(`[참고 문맥]`) 안에 배치하고, 원본 질의와 결합하여 단일 프롬프트 문자열로 완성한다. 마지막으로 `generate()` 함수가 완성된 프롬프트를 언어 모델의 API 엔드포인트로 전송한다. 이처럼 검색기가 사실 확인과 데이터 필터링을 전담함으로써, 언어 모델은 전체 데이터에서 정보를 직접 탐색하는 대신 주어진 문맥을 논리적으로 종합해 자연스러운 문장으로 서술하는 본래 역할에 집중할 수 있다.

---

## 3. 증강 프롬프트 조립과 스키마

지식 베이스나 데이터베이스에서 검색된 결과는 대개 파이썬 딕셔너리(`dict`)나 테이블의 레코드 형태를 띤다. 이 원시 객체를 `str(dict)` 형태로 프롬프트에 그대로 넣으면 문제가 발생한다. 중괄호와 따옴표 같은 구문 기호가 불필요하게 토큰을 소비한다. 또한 필드 경계가 불명확해 모델이 수치나 속성을 혼동하기 쉽다. 따라서 모델이 읽기 편한 자연어 문장 구조로 데이터를 변환해야 한다.

실습 환경에서는 부동산 매물 딕셔너리 데이터를 예시로 사용한다. 아래 코드는 원시 레코드를 서술형 문장으로 가공하고, 이를 프롬프트 템플릿에 결합하는 과정을 보여준다.

```python
# 1. 딕셔너리 데이터를 읽기 쉬운 문장 레이아웃으로 변환
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

# 2. 지시문, 문맥 데이터, 질문을 결합한 증강 프롬프트 생성
def generate_prompt(query: str, houses: list[dict]) -> str:
    houses_layout = house_info_layout(houses)
    prompt = f"""Use the following houses information to answer users queries.
{houses_layout}
Query: {query}"""
    return prompt
```

`house_info_layout()` 함수는 매물 딕셔너리를 순회하며 주소, 방 개수, 면적, 가격 정보를 한 줄의 설명 문장으로 정리한다. 각 매물 정보는 줄바꿈(`\n`)으로 구분하여 모델이 개별 레코드를 독립된 단위로 인식하게 만든다. `generate_prompt()` 함수는 이 가공된 텍스트(`houses_layout`)를 지시문 아래에 배치하고 맨 마지막에 사용자의 `Query`를 덧붙인다. 지시문과 문맥, 질문이 명확한 구획으로 나뉘어 있어 모델이 어떤 데이터를 참고해 무엇에 답해야 하는지 직관적으로 파악할 수 있다.

이렇게 문맥을 주입했을 때와 주입하지 않았을 때의 모델 출력 차이는 분명하다. "가장 비싼 집과 가장 넓은 집은 어디인가?"라는 질문을 단독으로 보냈을 때, 모델은 해당 매물에 대한 정보가 없으므로 집을 고르는 일반적인 기준만 설명한다. 반면 가공된 매물 문맥을 함께 전달하면, 모델은 Shelbyville 소재 주택(\$320,000, 2,500 sq ft)과 Springfield 소재 주택(\$230,000, 1,500 sq ft)의 수치를 정확히 비교해 정답을 찾아낸다. 정형화된 프롬프트 템플릿으로 데이터를 주입하는 작업이 모델의 환각을 줄이는 기본 검증 수단이 된다.

---

## 4. 뉴스 데이터 기반 파이프라인

### 벡터 유사도 검색과 기사 조회 내부 구조

단순 텍스트 매칭만으로는 질문의 의도와 문서의 의미적 연관성을 정밀하게 파악하기 어렵다. 따라서 현대 검색기는 문장을 고차원 수치 벡터로 변환하는 임베딩 모델과 벡터 간 유사도 연산을 활용한다.

실습 환경에서는 2024년 뉴스 데이터셋(`news_data_dedup.csv`)을 지식 베이스로 사용한다. 아래 코드는 질문 임베딩 생성부터 코사인 유사도 계산, 그리고 상위 문서 인출까지의 실제 내부 구현이다.

```python
import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.metrics.pairwise import cosine_similarity

# 1. 질문 임베딩 생성과 코사인 유사도 기반 인덱스 추출
def retrieve(query: str, top_k: int = 5) -> np.ndarray:
    # 질문 텍스트를 768차원 밀집 벡터로 변환
    query_embedding = model.encode(query)

    # 사전 계산된 기사 임베딩 행렬과 코사인 유사도 일괄 계산
    similarity_scores = cosine_similarity(query_embedding.reshape(1, -1), EMBEDDINGS)[0]

    # 유사도 점수 내림차순으로 원본 기사 행 인덱스 정렬
    similarity_indices = np.argsort(-similarity_scores)
    top_k_indices = similarity_indices[:top_k]

    return top_k_indices

# 2. 인덱스 리스트를 받아 실제 뉴스 기사 레코드 인출
def query_news(indices: list[int]) -> list[dict]:
    output = [NEWS_DATA[index] for index in indices]
    return output

# 3. 검색과 조회를 하나로 결합한 파이프라인 함수
def get_relevant_data(query: str, top_k: int = 5) -> list[dict]:
    relevant_indices = retrieve(query=query, top_k=top_k)
    relevant_data = query_news(relevant_indices)
    return relevant_data
```

`model.encode()`는 BGE-base 모델을 사용해 가변 길이의 질문 텍스트를 768차원의 밀집 벡터(Dense Vector)로 압축 변환한다. 이 벡터와 사전 계산된 전체 기사 임베딩 행렬(`EMBEDDINGS`)을 `cosine_similarity()`에 전달하여 유사도 점수를 구한다.

기하학에서 두 점 사이의 최단 직선 거리를 재는 유클리드 거리(Euclidean Distance)는 값의 절대적 차이를 비교한다. 하지만 수백에서 수천 차원에 달하는 고차원 공간에서는 모든 점 사이의 거리가 멀어져 거리의 변별력이 약해진다. 또한 문서의 길이나 단어 수에 따라 벡터의 물리적 크기가 왜곡된다. 따라서 값의 크기 대신 두 벡터가 가리키는 **방향(Angle)**의 일치도를 측정하기 위해 코사인 유사도를 사용한다. 예를 들어 $[10, 10]$과 $[100, 100]$은 크기가 다르지만 가리키는 방향이 같으므로 의미적으로 동일한 주제로 판단할 수 있다.

코사인 유사도는 두 벡터 $u$와 $v$ 사이의 사잇각 코사인 값을 측정하는 지표다. 수식으로는 두 벡터의 내적을 각 벡터의 L2 노름(크기) 곱으로 나눈 값이다.

$$\text{Cosine Similarity}(u, v) = \frac{u \cdot v}{\|u\|_2 \|v\|_2}$$

넘파이로 표현하면 `np.dot(u, v) / (np.linalg.norm(u) * np.linalg.norm(v))`와 같다. 두 벡터의 방향이 완전히 일치하면 1, 직교하면 0, 반대 방향이면 -1을 가진다.

유사도 점수가 계산되면 `np.argsort(-similarity_scores)`를 실행한다. 점수 배열 자체를 정렬하면 점수 값만 남고 어떤 기사의 점수인지 알 수 없다. 따라서 값의 내림차순 순서를 유지하면서 해당 원소의 원래 위치(행 번호)를 배열로 반환하는 `argsort`를 사용한다. 상위 `top_k`개의 인덱스를 슬라이싱한 뒤, `query_news()`가 리스트 컴프리헨션으로 메모리에 로드된 기사 딕셔너리를 즉시 추출한다. `get_relevant_data()`는 이 두 함수를 결합해 질문에 대응하는 최적의 기사 레코드 목록을 반환한다.

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
    if not use_rag:
        return query

    # 상위 k개 기사 검색 및 텍스트 정리
    relevant_data = get_relevant_data(query, top_k=top_k)
    retrieve_data_formatted = format_relevant_data(relevant_data)

    if prompt is None:
        prompt = (
            f"Answer the user query below. There will be provided additional information for you to compose your answer. "
            f"The relevant information provided is from 2024 and it should be added as your overall knowledge to answer the query, "
            f"you should not rely only on this information to answer the query, but add it to your overall knowledge.\n"
            f"Query: {query}\n"
            f"2024 News: {retrieve_data_formatted}"
        )
    else:
        prompt = prompt.format(query=query, documents=retrieve_data_formatted)

    return prompt
```

`format_relevant_data()` 함수는 기사 딕셔너리에서 제목(`title`), 요약(`description`), 발행일(`published_at`), 출처(`url`)를 추출한다. 개별 기사를 하나의 문자열로 묶고 줄바꿈(`\n`)으로 구분하여 텍스트 블록을 구성한다.

`generate_final_prompt()` 함수는 `use_rag` 플래그를 통해 파이프라인의 동작을 제어한다. `use_rag=False`인 경우 외부 검색을 건너뛰고 사용자의 원본 질의만 그대로 반환한다. 반면 `use_rag=True`이면 `get_relevant_data()`와 `format_relevant_data()`를 순차 호출해 기사 문맥을 추출한다. 기본 프롬프트 템플릿은 모델에게 제공된 문맥이 2024년 최신 정보임을 명시하고, 기존 사전학습 지식과 결합하여 질의에 답변하도록 유도한다. 발행일과 URL 메타데이터를 함께 주입하므로 모델이 시점을 오인하지 않고 근거에 기반해 답변을 생성할 수 있다.

### 모델 호출과 최신 뉴스 답변 비교

증강 프롬프트가 완성되면 이를 언어 모델 API 엔드포인트에 전달하여 최종 답변을 생성한다. 전체 파이프라인을 묶는 종단간(End-to-End) 호출 함수는 다음과 같다.

```python
# 검색, 프롬프트 조립, LLM 생성을 통합하는 종단간 파이프라인 함수
def llm_call(query: str, top_k: int = 5, use_rag: bool = True, prompt: str = None) -> str:
    # 1. 프롬프트 생성 (RAG 여부에 따라 일반 질의 또는 증강 프롬프트 반환)
    final_prompt = generate_final_prompt(query, top_k=top_k, use_rag=use_rag, prompt=prompt)

    # 2. 언어 모델 호출 (Together AI Qwen/Qwen3.5-9B)
    generated_response = generate_with_single_input(final_prompt)

    # 3. 모델이 생성한 텍스트 응답 추출
    generated_message = generated_response['content']
    return generated_message
```

`llm_call()` 함수는 앞서 구현한 `generate_final_prompt()`를 호출해 완성된 프롬프트를 얻는다. 이어 `generate_with_single_input()`을 통해 Together AI의 Qwen 9B 모델 API로 프롬프트를 전송하고 생성 결과를 반환한다.

이 파이프라인에 최신 경제 질의인 `"Tell me about the US GDP in the past 3 years."`(최근 3년간 미국 GDP 현황에 대해 알려달라)를 입력하여 RAG 적용 여부에 따른 출력 차이를 비교한다.

먼저 RAG를 적용하지 않은 경우(`use_rag=False`), 모델은 사전 학습 데이터에 포함된 2021\~2023년 과거 지식만 참조한다. 2024년 1분기 경제 성장률이나 최신 IMF 전망치는 알지 못하므로, 과거 일반론을 서술하거나 최근 상황에 대해 불확실한 추측을 내놓는다.

반면 RAG를 적용한 경우(`use_rag=True`), 검색기는 2024년 4월 월스트리트저널(WSJ) 기사들을 프롬프트에 주입한다. 검색된 기사에는 "올해 미국이 전 세계 GDP의 26.3%를 차지해 20년 만에 최고치를 기록할 것이라는 IMF 전망"과 "2024년 1분기 미국 GDP 성장률이 연율 1.6%로 집계되었다"는 최신 수치가 담겨 있다. 모델은 주입된 문맥을 바탕으로 2024년 4월 시점의 구체적인 경제 지표와 수치를 인용한 정확한 답변을 생성한다.

이처럼 검색기를 결합한 RAG 아키텍처는 모델의 고정된 사전학습 가중치를 재학습하지 않고도, 외부 지식 베이스의 최신 사실을 프롬프트 문맥으로 실시간 공급하여 신뢰성 높은 답변을 완성한다. 또한 프롬프트에 포함된 기사 발행일과 출처 URL은 단순한 배경 정보에 그치지 않는다. 모델이 문맥을 인용해 답변할 때 출처(Citation)를 함께 명시하도록 유도할 수 있다. 이를 통해 사용자는 모델의 출력을 맹신하지 않고 원본 문서를 직접 대조하여 사실 여부를 교차 검증할 수 있다.

---

## 5. 참고 자료

1. **DeepLearning.AI** — *Retrieval Augmented Generation (RAG)*, Module 1: "Introduction to RAG Systems" (Instructor: Zain Hasan, Andrew Ng)
