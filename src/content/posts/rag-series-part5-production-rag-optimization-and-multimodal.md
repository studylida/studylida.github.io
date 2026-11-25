---
title: "RAG 파이프라인 5편: 서비스 평가, 비용과 속도 최적화, 보안과 멀티모달 RAG"
description: "실제 서비스 환경의 RAG 평가와 Phoenix 트레이싱, 벡터 양자화와 3계층 스토리지 최적화, 보안 설계와 멀티모달 RAG까지 구현과 함께 정리한다."
pubDate: "2026-11-12 16:30:00"
tags: ["RAG", "Observability", "Phoenix", "OpenTelemetry", "Quantization", "Matryoshka", "MultimodalRAG", "Weaviate"]
categories: ["AI", "Python"]
draft: false
---

단일 개발 환경에서 샘플 질문 몇 개로 프로토타입을 만들 때와 달리, 실제 서비스 환경에 RAG 시스템을 배포하면 새로운 문제가 한꺼번에 나타난다. 트래픽 증가로 비용과 지연 시간이 급증하고, 예측하기 어려운 사용자 질문이 들어오며, 사내 기밀 유출 위험도 방어해야 한다.

이번 글에서는 서비스 환경의 RAG 평가 전략과 관측성(Observability) 구축을 먼저 다룬다. 이어서 벡터 양자화(Quantization)를 비롯한 비용과 속도 최적화 기법, 보안 설계 및 멀티모달 RAG 구조를 살펴본다. 후반부에서는 OpenTelemetry와 Arize Phoenix로 파이프라인을 추적하고, 4편에서 만든 의류 쇼핑몰 챗봇의 토큰 소모량과 응답 시간을 줄이는 리팩토링을 구현한다.

---

## 1. 운영 환경과 평가 전략

### 1) 실제 서비스 환경이 프로토타입보다 어려운 5가지 이유

1. **트래픽 확장에 따른 성능 및 비용 압박**: 사용자 수가 늘어나면 동시 처리 요청 수(Throughput, 처리량)와 응답 대기 시간(Latency, 지연 시간)에 병목이 생긴다. 요청 증가는 메모리와 연산 사용량 증가로 이어져 인프라 및 API 과금 비용을 높인다.
2. **예측 불가능하고 다양한 사용자 프롬프트**: 출시 전에 아무리 꼼꼼하게 테스트 데이터셋을 구축하더라도, 실제 사용자가 입력하는 낯선 질문 유형을 모두 예측할 수는 없다. 사전 테스트에서 높은 점수를 받은 시스템도 실사용자의 질문 앞에서는 품질이 크게 흔들릴 수 있다.
3. **비정형적이고 파편화된 문서 데이터**: 실제 기업의 문서는 포맷이 깨져 있거나 메타데이터가 누락된 경우가 많다. 또한 핵심 정보가 순수 텍스트가 아니라 이미지, PDF, 발표 자료(Presentation decks) 안에 들어 있어 이를 지식베이스로 읽어 들이는 별도의 처리가 필요하다.
4. **보안 및 개인정보 보호(Security & Privacy)**: 기업이 자체 RAG 시스템을 구축하는 주된 이유는 지식베이스 데이터가 외부에 공개되지 않은 사내 기밀이기 때문이다. 인가된 사용자에게만 접근을 허용하면서 기밀 유출을 막는 장치가 필수적이다.
5. **오답이 곧바로 서비스 피해로 직결되는 위험**:
   - **유머 글을 사실로 오인한 요약 오류**: 한 검색 요약 서비스에서는 사용자가 `"하루에 돌을 몇 개나 먹어야 하나요?"`라고 묻자, 검색기가 커뮤니티 풍자 글을 가져왔다. LLM이 이를 농담으로 구분하지 못하고 `"하루에 작은 돌멩이를 먹으라"`고 답해 큰 신뢰도 타격을 입었다.
   - **챗봇의 가짜 할인 약속 및 프롬프트 악용**: 존재하지 않는 할인 정책을 고객에게 안내해 배상 책임으로 이어지거나, 악의적인 사용자가 프롬프트를 조작해 유료 상품을 무료로 받으려 시도하는 등 서비스 단계의 오류는 실질적 피해로 이어진다.

### 2) 통합 관측성(Observability) 플랫폼의 4대 필수 기능

이러한 운영 문제를 사전에 감지하고 원인을 추적하려면 네 가지 요소를 갖춘 관측성 시스템이 필요하다.
1. **소프트웨어 성능 지표(Performance Metrics) 추적**: 지연 시간(Latency), 초당 처리 요청 수(Throughput), 메모리 및 연산 자원 사용량을 상시 측정한다.
2. **품질 지표(Quality Metrics) 추적**: 검색기의 재현율(Recall)부터 최종 답변의 근거 충실도까지 결과물이 목표 기준을 충족하는지 측정한다.
3. **집계 통계와 상세 로그의 이원화**:
   - **집계 통계(Aggregate Statistics)**: 시간에 따른 성능 추세를 파악하고 업데이트 이후의 품질 저하(Regression)를 빠르게 감지한다.
   - **상세 로그(Detailed Logs / Traces)**: 개별 프롬프트 하나가 파이프라인을 통과한 전체 경로를 기록해 저품질 응답의 발생 원인을 찾아낸다.
4. **실험 및 A/B 테스트(Experimentation)**: 새로운 LLM 교체, 시스템 프롬프트 수정, 리랭커 추가 효과를 격리된 환경에서 비교하거나 사용자 트래픽을 나누어 검증한다.

### 3) 평가 설계 프레임워크: `평가 범위(Scope)` × `평가자 유형(Evaluator Type)`

RAG 시스템에서 수집할 수많은 평가 지표는 **어디를 평가하는가(Scope)**와 **누가 채점하는가(Evaluator Type)**라는 두 축의 격자(Grid)로 정리할 수 있다.

![평가 범위(Scope)와 평가자 유형(Evaluator Type) 2차원 매트릭스](/images/rag/module5/eval_scope_type_grid.png)

#### ① 축 1 — 평가 범위 (Scope)
- **시스템 전체 평가(System-level / End-to-End)**: 파이프라인 전체의 종합 성능을 요약하며 **"현재 시스템에 무슨 문제가 존재하는가"**를 보여준다 (예: 전체 응답 지연 시간, 전체 토큰 사용량, 최종 답변 만족도 비율).
- **컴포넌트 단위 평가(Component-level)**: 검색기, 리랭커, 라우터, 생성 LLM 등 개별 부품을 따로 측정하며 **"문제가 어디서, 왜 발생했는가"**를 디버깅하게 해준다 (예: 검색기 지연 시간, 검색 문서 관련성).

#### ② 축 2 — 평가자 유형 (Evaluator Type)

| 평가자 유형 | 측정 방식 및 대표 지표 | 장단점과 설계 유의점 |
|---|---|---|
| **코드 기반 평가**<br>(Code-based) | 규칙 기반 코드로 자동 측정 (지연 시간, 초당 토큰 수 TPS, JSON 문법 단위 테스트) | 비용이 거의 들지 않고 재현성이 100%지만 문장의 의미 품질은 평가할 수 없음 |
| **인간 피드백 평가**<br>(Human Feedback) | 좋아요/싫어요 사용자 피드백과 사전 라벨링된 `'질문-정답 문서'` 데이터셋 활용 | 실제 체감 품질을 가장 잘 포착하지만 구축 비용과 시간이 많이 듦 |
| **심판 LLM 평가**<br>(LLM-as-a-Judge) | 별도 LLM이 채점 기준에 따라 근거 충실도(Faithfulness)와 관련성, 인용 정확도를 채점 | 인간 평가보다 저렴하지만 자기 계열 편향을 보정해야 하며 이산 기준(`Relevant / Irrelevant`)이 일관됨 |

초기 운영 모니터링을 구축할 때는 네 가지 지표를 조합해 출발하는 편이 균형 잡혀 있다. 먼저 코드 기반으로 시스템과 컴포넌트별 지연 시간과 토큰 수를 잰다. 여기에 사용자의 좋아요/싫어요 피드백과 사전 라벨링 데이터셋 기반 검색 Precision/Recall을 결합한다. 마지막으로 RAGAS 같은 심판 LLM 평가로 답변 관련성과 인용 품질을 함께 추적한다.

---

## 2. 관측성과 맞춤형 데이터셋

### 1) Arize Phoenix 트레이스와 인프라 모니터링 도구의 역할 분담

관측성 시스템을 밑바닥부터 직접 구현하는 대신 **Arize Phoenix** 같은 오픈소스 LLM 관측성 플랫폼을 도입하면 트레이스 수집과 평가에 바로 집중할 수 있다.

![Arize Phoenix UI에서 확인한 RAG 파이프라인 트레이스와 검색 문서 상세 정보](/images/rag/module5/phoenix_trace_overview.png)

- **트레이스(Trace) 분석**: 초기 사용자 질문 ➔ 검색기에 전달된 쿼리 ➔ 검색기가 반환한 문서 청크들 ➔ 리랭커 처리 결과 ➔ 생성 LLM에 전달된 최종 증강 프롬프트 ➔ 최종 생성 응답에 이르는 전 과정과 단계별 소요 시간을 트리 구조로 시각화한다.
- **RAGAS 통합 및 일간 리포트**: RAGAS 라이브러리를 연결해 검색 관련성이나 환각 발생률(Hallucination rate)을 자동 채점하고 일별 집계 리포트를 생성한다.
- **전통적 인프라 모니터링 도구와의 결합**: Phoenix 같은 LLM 전용 플랫폼은 프롬프트 흐름과 응답 품질 분석에는 뛰어나지만, **벡터 데이터베이스 서버의 CPU 연산량이나 RAM 점유율 같은 하드웨어 리소스를 감시하는 용도로는 적합하지 않다.** 따라서 하드웨어와 인프라 리소스 감시는 **Datadog**이나 **Grafana** 같은 기존 관측 도구를 함께 사용해 보완해야 한다.

### 2) 실사용 트래픽으로 맞춤형 평가 데이터셋 만들기

실제 서비스에서 접수된 고객 프롬프트와 각 컴포넌트의 중간 입출력 기록을 모아 **맞춤형 데이터셋(Custom Dataset)**을 만들 수 있다. 이를 활용하면 시스템 프롬프트나 검색 설정을 바꿀 때마다 과거 질문들에 대한 응답 변화를 재실행(Re-run)하며 정밀하게 검증할 수 있다.

- **무엇을 저장할 것인가?**: 전체 파이프라인(End-to-End)만 평가한다면 `입력 프롬프트`와 `최종 응답` 두 열만 저장해도 된다. 하지만 검색기, 리랭커, 라우터 LLM 중 어디에 병목이 있는지 **컴포넌트 단위 평가**를 하려면 모든 중간 입출력을 함께 남겨야 한다. 실제 운영 RAG 로깅 테이블은 고객 ID, 검색 청크 목록, 리랭킹 전후 순위, 라우터 분류 라벨 등 수십 개 열로 구성된다.

![토픽별 응답 품질 편차 분석과 Mermaid 다이어그램 라우터 버그 역추적 사례](/images/rag/module5/custom_eval_analysis.png)

이렇게 다차원 로그를 쌓아두면 두 가지 방식으로 문제를 해결할 수 있다.
1. **토픽별 품질 편차 분석(왼쪽 그림)**: 고객센터 챗봇 로그를 주제별로 필터링한 결과, 계정 설정(87%), 환불 문의(92%), 상품 기능(84%)은 높은데 유독 **배송 지연 문의(58%)**만 품질이 낮았다. 세부 지표를 대조해 보니 **근거 충실도(`Faithfulness: 68%`)**는 괜찮은 반면 **검색 정밀도(`Context Precision: 42%`)**와 **평균 검색 청크 수(`1.5개`)**가 크게 떨어졌다. 즉 생성 LLM이 환각을 일으킨 것이 아니라 지식베이스 내 배송 지연 문서 자체가 부족함을 입증해 문서를 보강했다.
2. **에이전트 라우터 오분류 역추적 사례(오른쪽 그림)**: 텍스트, 일반 이미지(Diffusion 모델), Mermaid.js 다이어그램을 모두 생성하는 복합 시스템에서 `"다이어그램 품질이 너무 낮다"`는 불만이 들어왔다. 로그를 추적해 보니 `"Draw a diagram"` 질문에서 **라우터 LLM이 `"Draw"` 단어에 이끌려 코드 생성기 대신 일반 이미지 생성 모델로 잘못 분기**하고 있었다. 원인을 파악한 즉시 라우터 시스템 프롬프트를 고쳐 다이어그램 요청을 코드 기반 차트 생성기로 바로 보냈다.
3. **프롬프트 클러스터링 시각화**: 대량의 입력 프롬프트 임베딩을 군집화(Clustering)하면 사용자들이 주로 묻는 질문 분포(기술 문의 vs 일반 문의 등)를 파악하고 특정 군집만 따로 떼어 성능을 평가할 수 있다.

---

## 3. 양자화와 벡터 크기 압축

관측성 파이프라인을 갖추었다면 이제 **비용(Cost), 속도(Latency), 품질(Quality)** 사이의 균형을 최적화할 차례다. 여기서 핵심이 되는 압축 기술이 **양자화(Quantization)**다.

### 1) 양자화의 원리와 임베딩 벡터의 메모리 점유량

양자화란 LLM의 가중치나 임베딩 벡터의 수치들을 **더 낮은 정밀도의 데이터 타입으로 변환해 용량을 줄이는 기법**이다. 픽셀당 24비트를 쓰던 이미지를 12비트나 6비트로 줄여 약간의 색상 손실을 감수하고 파일 크기를 줄이는 것과 같은 원리다.

- **LLM 가중치 양자화**: 일반적인 LLM은 파라미터당 **16비트(2바이트)**를 사용한다. 10억(1B)\~1조(1T) 개의 파라미터를 가진 모델을 구동하려면 막대한 GPU VRAM이 필요하다. 이를 **8비트(용량 1/2)** 또는 **4비트(용량 1/4)** 정수로 양자화하면 약간의 품질 저하만으로 GPU 메모리 요구량을 크게 줄이고 추론 속도를 높일 수 있다.
- **임베딩 벡터의 메모리 크기**: 일반적인 임베딩 벡터는 차원마다 **32비트 부동소수점(`float32` = 4바이트)**을 사용한다. 벡터 1개의 크기는 `차원 수 × 4바이트`이며, 문서가 100만 개($10^6$ vectors)로 늘어나면 RAM에 상주시켜야 하는 용량이 수 GB에서 수십 GB로 커진다.

![주요 임베딩 모델의 차원 수에 따른 단일 벡터 및 100만 개 벡터 용량 비교](/images/rag/module5/embedding_vector_sizes.png)

- **SBERT (`all-mpnet-base-v2`, 768차원)**: 벡터 1개당 `3 KB` ➔ 100만 개 저장 시 **`3 GB`**
- **OpenAI (`text-embedding-ada-002`, 1,536차원)**: 벡터 1개당 `6 KB` ➔ 100만 개 저장 시 **`6 GB`**
- **Cohere (`embed-english-v2.0`, 4,096차원)**: 벡터 1개당 `16 KB` ➔ 100만 개 저장 시 **`16 GB`**

### 2) 임베딩 벡터를 압축하는 3대 기법

#### ① 8비트 정수 양자화 (8-bit Integer / Scalar Quantization)
32비트 실수(`float32`)를 8비트 정수(`uint8`, `0 ~ 255`)로 치환해 **벡터 용량을 1/4(4배 압축)**로 줄이는 기법이다.

![32비트 부동소수점 벡터를 8비트 정수 벡터로 변환하는 4단계 과정](/images/rag/module5/quantization_8bit_process.png)

위 그림처럼 변환 과정은 4단계로 이루어진다.
1. **최솟값(Min)과 최댓값(Max) 탐색**: 각 차원에서 등장하는 값의 범위를 찾는다 (예: `[0.0, 0.5, 1.0, 2.0]`이면 `Min = 0.0`, `Max = 2.0`).
2. **256개 균등 구간으로 분할**: 8비트($2^8 = 256$) 표현 개수에 맞춰 전체 범위를 256개 구간으로 나누고 구간 폭(`Scale = (2.0 - 0.0) / 256 = 0.00781`)을 구한다.
3. **정수 할당(`0 ~ 255`)**: 각 실수가 속한 구간에 정수를 배정한다 (`0.0 ➔ 0`, `0.5 ➔ 64`, `1.0 ➔ 128`, `2.0 ➔ 255`).
4. **복원용 메타데이터 저장**: 나중에 원래 32비트 실수 근사치를 역산할 수 있도록 **최솟값(`Min = 0.0`)과 구간 폭(`Scale = 0.00781`)** 두 값만 함께 저장한다.

이처럼 단순한 방식임에도 용량은 1/4로 줄고 거리 계산이 빨라지며, `Recall@K` 벤치마크 성능 하락은 **몇 퍼센트 포인트** 수준에 그친다.

#### ② 1비트 이진 양자화 (1-bit / Binary Quantization)와 재채점(Rescoring)
- 32비트 실수를 **1비트(`0` 또는 `1`)**로 바꾸어 **벡터 크기를 1/32(32배 압축)**로 줄이는 기법이다. 원래 차원의 값이 **양수(Positive)이면 `1`, 음수(Negative)이면 `0`**만 부여한다.
- 극단적인 압축 때문에 단독 사용 시에는 검색 정확도가 눈에 띄게 떨어진다. 따라서 실제 서비스에서는 **① 가벼운 1비트 양자화 벡터로 빠르게 1차 후보군을 검색한 뒤, ② 원본 32비트 전체 정밀도 벡터로 후보군만 정밀 재채점(Rescoring)**하는 2단계 결합 방식을 주로 사용한다.

#### ③ 마트료시카 임베딩 모델 (Matryoshka Embedding Models)
개별 숫자의 비트 수를 줄이는 대신, **전체 벡터 차원 중 앞쪽 일부 차원만 잘라서(예: 1,000차원 중 앞 100차원만 사용)** 유사도를 계산하도록 특수 훈련된 모델이다.

![정보 밀도(분산) 순으로 차원을 정렬하는 마트료시카 임베딩 구조](/images/rag/module5/matryoshka_embeddings.png)

- **일반 임베딩 모델과의 차이**: 일반 임베딩 모델은 모든 차원이 비슷한 수준의 **통계적 분산(정보량)**을 나누어 갖기 때문에 앞쪽 차원만 자르면 정보가 심하게 손실된다. 반면 마트료시카 모델은 학습 과정에서 **앞쪽 차원(Earlier dimensions)에 가장 큰 분산을 몰아주고 뒤쪽 차원으로 갈수록 분산이 작아지도록 정렬**한다.
- **활용 전략**: 처음부터 앞 100차원만 저장해 공간과 연산량을 절약하거나, **빠른 RAM에 올라간 앞쪽 100차원으로 1차 고속 검색을 수행한 뒤 디스크에서 나머지 900차원을 불러와 전체 1,000차원으로 재채점(Rescoring)**하는 동적 구성을 쓸 수 있다.

---

## 4. 비용과 지연 시간 최적화

### 1) LLM 비용 절감 전략 3가지

운영 환경 RAG의 양대 비용 발생원은 **LLM 추론 비용**과 **벡터 데이터베이스 비용**이다. 먼저 LLM 비용을 줄이는 세 가지 방법은 다음과 같다.
1. **소형 모델이나 양자화 모델, 파인튜닝 활용**: 핵심 생성 모델이나 에이전트 내부 라우터를 파라미터 수가 적은 소형 모델(또는 8비트 양자화 모델)로 교체한다. 특히 단일 역할만 수행하는 라우터는 소형 모델을 파인튜닝하면 저렴한 비용으로 높은 정확도를 얻을 수 있다.
2. **입력 및 출력 토큰 수 제한**: 검색기가 가져오는 문서 수(`top_k`)를 줄여 입력 프롬프트 길이를 낮춘다. 동시에 시스템 프롬프트에 간결한 답변을 지시하거나 `max_tokens` 상한선을 고정해 출력 과금을 억제한다.
3. **전용 하드웨어 엔드포인트(Dedicated Endpoints) 전환**: 프로토타입 단계에서는 클라우드의 **토큰당 과금(Pay-per-token)** API가 유리하다. 그러나 트래픽이 수십만\~수백만 건 규모로 커지면 전용 GPU 서버를 임대해 **시간당 비용을 지불하는 전용 엔드포인트**로 전환하는 편이 훨씬 저렴하고 응답 안정성도 높다.

### 2) 벡터 DB 비용 절감: 3계층 스토리지 분리와 멀티 테넌시

벡터 데이터베이스는 속도와 GB당 단가가 다른 **3가지 스토리지 계층(`RAM` ➔ `Disk` ➔ `Cloud Object Storage`)**을 조합해 사용한다.

![벡터 DB 3계층 스토리지 분리 원칙과 멀티 테넌시 동적 메모리 로딩](/images/rag/module5/vector_db_storage_tiers.png)

1. **데이터 성격에 따른 3계층 분리(왼쪽 그림)**:
   - **RAM (가장 빠름, 가장 비쌈)**: 고속 벡터 탐색에 필수적인 **HNSW 인덱스**만 상주시킨다.
   - **디스크 / SSD 메모리 (중간 속도, 중간 비용)**: 벡터 탐색 중에는 원본 텍스트가 필요하지 않다. **자주 조회되는 문서 본문**이나 **드물게 접근하는 벡터**는 SSD/디스크로 내려 보관한다.
   - **클라우드 오브젝트 스토리지 (가장 느림, 가장 저렴함)**: **드물게 조회되는 문서 본문 및 대용량 객체**를 보관한다.
2. **멀티 테넌시(Multi-tenancy) 기반 동적 메모리 이동(오른쪽 그림)**:
   - 전체 문서를 고객이나 조직(Tenant) 단위로 분할해 **각 테넌트마다 독립된 HNSW 인덱스**를 두면 모든 고객 데이터를 24시간 RAM에 올려둘 필요가 없다.
   - **온디맨드 데이터 로딩(On-demand Data Loading)**: 특정 고객이 실제로 로그인했을 때만 해당 테넌트의 벡터를 RAM으로 로드한다.
   - **시간대 기반 최적화(Time Zone Optimization)**: 지역별 주간 시간대에 맞춰 고속 스토리지(RAM)에 유지하고, 심야 시간대에는 저속 스토리지로 내려 RAM 비용을 절감한다.

### 3) 지연 시간(Latency) 단축: 트랜스포머 병목 해소와 시맨틱 캐싱

지연 시간 목표는 도메인에 따라 다르다. 이커머스 상품 추천이나 고객 상담 챗봇은 약간의 품질을 양보하더라도 즉각적인 응답(**속도 최우선**)이 필요하지만, 의료 진단 보조 시스템은 시간이 걸려도 **정확도 최우선**이다.

![RAG 파이프라인의 지연 시간 주범(트랜스포머)과 시맨틱 캐싱 구조](/images/rag/module5/latency_and_caching.png)

파이프라인 지연을 측정하면 벡터 DB 검색 자체는 매우 빠르며, **대부분의 지연 시간은 트랜스포머(Transformer) 모델 추론 단계에서 발생**한다. 따라서 병목이 큰 생성 LLM부터 순서대로 최적화해야 한다.

1. **1순위 — 핵심 생성 LLM 지연 시간 단축**:
   - **소형/양자화 모델 및 난이도별 라우팅**: 경량 라우터 LLM이 단순 질문은 소형 모델로, 복잡한 추론 질문만 대형 모델로 분기하게 설계한다.
   - **시맨틱 캐싱(Semantic Caching, 오른쪽 그림)**: 자주 들어오는 질문과 모범 답변을 캐시에 저장해 둔다. 새 질문(예: `"How do I reset my password?"`)이 들어오면 캐시된 질문들과 유사도를 비교해 임계치(예: 95%) 이상일 때 느린 생성 LLM 호출을 건너뛰고 캐시된 답변을 즉시 반환한다. 미세한 표현 조정이 필요하면 캐시 답변을 소형 LLM으로 살짝 다듬어 내보낸다.
2. **2순위 — 부가 트랜스포머 컴포넌트 가지치기**:
   - 라우터 LLM(+50ms), 리랭커(+200ms), 쿼리 재작성기(+300ms) 등 각 컴포넌트가 추가하는 지연 시간과 품질 향상폭을 비교해 이득이 미미한 단계는 생략한다.
3. **3순위 — 검색기(Retriever) 최적화**:
   - **1비트 이진 양자화 임베딩**으로 거리 계산을 단순화하거나, 거대해진 인덱스를 여러 인스턴스로 나누는 **데이터베이스 샤딩(Sharding)**을 적용한다.

---

## 5. 보안과 멀티모달 RAG

### 1) RAG 지식베이스의 3대 보안 위협과 방어 설계

비공개 사내 기밀을 담은 지식베이스는 세 가지 경로로 유출될 수 있으며, 각 경로에 맞는 방어 계층이 필요하다.

![RBAC 멀티 테넌트 분리와 외부 LLM API 호출 시의 보안 통제권 상실](/images/rag/module5/security_tenant_and_leakage.png)

1. **프롬프트를 통한 직접 추출 시도 방어 (인증 및 물리적 멀티 테넌시 RBAC)**:
   - 교묘한 프롬프트로 지식베이스 원문을 유도 출력하는 공격을 막으려면 로그인 기반 **사용자 인증(Authentication)**과 역할 기반 접근 제어(**RBAC**)가 필수다.
   - 이때 모든 문서를 단일 DB에 넣고 메타데이터 필터링으로만 권한을 나누면 필터 버그나 우회에 취약하다. 따라서 **메타데이터 필터링은 '개인화' 용도로만 쓰고, '보안' 경계는 권한별로 분리된 물리적 테넌트(Separate Tenants)로 격리**해야 한다.
2. **외부 LLM API 전송 시 유출 방어 (완전 온프레미스 호스팅)**:
   - 검색된 기밀 청크를 외부 클라우드 LLM API로 전송하는 순간 데이터 보안 통제권을 잃는다. 기밀 데이터를 다룰 때는 벡터 DB와 LLM을 모두 자체 서버에서 구동하는 **온프레미스(On-premises) 환경**으로 구축해야 한다.
3. **벡터 DB 탈취와 밀집 벡터 역추적 공격(Vector Reconstruction Risk) 방어**:
   - HNSW 같은 ANN 검색 알고리즘이 작동하려면 **문서의 밀집 벡터는 복호화된 평문 상태로 RAM에 올라와 있어야 한다.**
   - 해킹에 대비해 **원본 텍스트 청크는 암호화해 저장**하고 프롬프트 조립 직전에만 복호화한다. 아울러 평문 밀집 벡터만으로 원본 텍스트를 역추적하는 공격을 완화하려면 상대 거리는 유지하면서 의미 복원을 어렵게 만드는 **노이즈 추가**, **수학적 변환**, **차원 축소** 기법을 검토한다(검색 정확도와의 트레이드오프 존재).

### 2) 멀티모달 RAG와 고밀도 문서를 위한 PDF RAG

이미지, 차트, 발표 자료, PDF를 함께 검색하고 답변하는 **멀티모달 RAG**를 구축하려면 임베딩 모델과 생성 LLM을 모두 멀티모달 모델로 전환해야 한다.

![공유 벡터 공간 기반 멀티모달 임베딩 검색과 시각-언어 모델의 이미지 패치 토큰화](/images/rag/module5/multimodal_embedding_space.png)

1. **멀티모달 임베딩 모델 (공유 벡터 공간)**:
   - 텍스트와 이미지를 **동일한 벡터 공간(Shared vector space)**에 매핑한다. 덕분에 `"dog"` 텍스트 벡터와 강아지 사진 벡터가 같은 영역에 배치되어 텍스트 질문으로 이미지를 찾거나 이미지로 텍스트를 찾는 검색이 기존 코사인 유사도 방식 그대로 동작한다.
2. **시각-언어 모델(Vision-Language Model, VLM)과 이미지 토큰화**:

![이미지를 격자 패치 토큰으로 변환해 텍스트와 함께 처리하는 시각-언어 모델](/images/rag/module5/vlm_image_tokenization.png)

   - VLM은 이미지를 작은 정사각형 **패치(Patches)**로 쪼개어 각 패치를 토큰으로 변환한다(해상도에 따라 이미지 1장당 **약 100개\~1,000개 토큰** 생성). 이 이미지 토큰과 텍스트 토큰을 하나의 시퀀스로 이어 트랜스포머에 입력한다.
3. **고밀도 문서(PDF와 발표 자료)를 위한 PDF RAG (ColBERT 방식 격자 채점)**:
   - 차트, 표, 캡션이 섞인 PDF 페이지를 벡터 1개로 압축하면 세부 정보가 손실된다. 과거 객체 탐지 모델로 영역을 잘라내던 방식은 오탐지가 잦고 깨지기 쉬웠다.

![PDF 페이지를 정사각형 격자 패치로 분할해 ColBERT 방식으로 점수를 합산하는 PDF RAG](/images/rag/module5/pdf_rag_patches.png)

   - 최신 **PDF RAG**는 영역 구분 없이 페이지 이미지를 **균등한 정사각형 격자(예: 페이지당 1,000개 패치)**로 쪼개 멀티모달 임베딩으로 벡터화한다.
   - 검색 시에는 3편에서 다룬 **ColBERT의 후기 상호작용(MaxSim)**과 동일하게, **질문 프롬프트의 각 단어 토큰이 페이지 내 패치 중 가장 유사도가 높은 패치를 찾아 최대 유사도를 합산**해 페이지 점수를 매긴다. 저장 벡터 수는 늘어나지만 어떤 복잡한 문서 양식에도 높은 검색 성능을 유지한다.

---

## 6. Phoenix 트레이싱

이제 관측성(Observability) 이론을 코드로 구현한다. **OpenTelemetry**와 **Arize Phoenix**를 사용해 RAG 파이프라인의 각 단계를 계측(Instrumentation)한다.

### 1) 기본 개념과 계측 문법: `Span`, `Trace`, `with ... as span:`

트레이싱 코드에 반복해서 등장하는 세 가지 개념을 먼저 짚는다.
- **스팬(Span)**: 시스템 내부의 **단일 작업 구간**(예: `문서 검색`, `프롬프트 조립`)으로, 시작과 종료 시각, 입력과 출력 데이터를 기록하는 실행 단위다.
- **트레이스(Trace)**: 하나의 사용자 질문이 들어와 최종 답변이 나갈 때까지 생성된 **모든 스팬의 전체 묶음(요청 여정)**이다.
- **체인(Chain)**: 여러 함수를 차례로 연결해 실행하는 파이프라인 단위다.

파이썬에서 스팬을 기록할 때는 **`with tracer.start_as_current_span(...) as span:`** 블록을 사용하거나, 함수 위에 **`@tracer.chain` / `@tracer.tool` 데코레이터**를 붙인다. 두 방식의 차이는 다음과 같다.

```python
# [방식 A] 세밀한 수동 기록 (with ... as span 블록)
# -> 검색기처럼 '검색된 개별 문서의 ID와 본문'을 스팬 객체에 직접 기록할 때 사용
def my_retriever(query: str):
    # 1. "query_weaviate" 이름의 실행 스팬을 시작 (들여쓰기 종료 시 소요 시간 자동 측정)
    with tracer.start_as_current_span("query_weaviate", openinference_span_kind="retriever") as span:
        # 2. 스팬에 입력값 기록
        span.set_input(query)

        # --- 실제 검색 로직 실행 ---
        docs = ["문서 1", "문서 2"]

        # 3. 부가 속성(Attribute)과 성공 상태(OK) 기록
        span.set_attribute("retrieval.documents.0.document.content", docs[0])
        span.set_status(Status(StatusCode.OK))
        return docs

# [방식 B] 간편 자동 기록 (@tracer.chain 또는 @tracer.tool 데코레이터)
# -> 문자열 포맷팅처럼 함수의 '입력 인자, 반환값, 실행 시간'만 자동 추적할 때 사용
@tracer.chain
def my_formatter(docs: list) -> str:
    return "\n".join(docs)
```

즉 코드에서 `span.set_input(...)`, `span.set_attribute(...)`, `span.set_status(...)`가 보이면 실제 검색 동작을 바꾸는 코드가 아니라, 대시보드에 실행 데이터를 남기는 계측 코드로 이해하면 된다.

Arize Phoenix의 기반이 되는 **순수 OpenTelemetry(OTel)**의 4대 기본 구성요소와 예외 기록 방식은 다음과 같다.
- **OpenTelemetry 4대 기본 구성요소**:
  1. `Resource(attributes={"service.name": "Test Service"})`: 트레이스를 생성하는 애플리케이션 이름과 환경 메타데이터를 정의한다.
  2. `TracerProvider(resource=resource)`: 설정된 리소스를 바탕으로 스팬을 발급하고 관리하는 본부 역할을 한다.
  3. `ConsoleSpanExporter()` (또는 OTLP HTTP Exporter): 수집된 스팬 데이터를 콘솔이나 Phoenix 서버 등 어디로 내보낼지 결정한다.
  4. `SimpleSpanProcessor(console_exporter)`: 스팬이 종료될 때마다 즉시 Exporter로 전달하는 처리기다.
- **스팬 내부 이벤트(`span.add_event`)와 오류 추적(`StatusCode.ERROR`)**:
  - 스팬 안에서 세부 단계가 진행될 때 `span.add_event("Starting retrieve")` 등을 호출하면 타임스탬프가 찍힌 로그 이벤트를 남길 수 있다.
  - 실행 중 예외(`Exception`)가 발생하면 `except Exception as e:` 블록에서 오류 상태와 예외 정보를 함께 기록한 뒤 예외를 다시 발생(`raise`)시킨다. `span.set_status(Status(StatusCode.ERROR, str(e)))`와 `span.record_exception(e)`를 함께 호출해 두면, 대시보드에서 어느 컴포넌트가 왜 실패했는지 즉시 붉은색 오류 표시로 식별할 수 있다.

### 2) Weaviate + Phoenix + OpenAI 자동 계측 파이프라인 구현

Phoenix의 `register()` 함수를 호출할 때 **`auto_instrument=True`** 옵션을 켜면, OpenAI 호환 클라이언트(`llm_client.chat.completions.create`) 호출 시 별도의 `with` 블록 없이도 프롬프트와 토큰 수가 자동 추적된다. 아래 코드는 로컬 Phoenix(포트 6006), Weaviate(포트 8079), OpenAI 호환 추론 서버가 실행된 환경에서 동작한다.

```python
import phoenix as px
from phoenix.otel import register
from opentelemetry.trace import Status, StatusCode
import weaviate
from openai import OpenAI

# 1. 로컬 Phoenix 대시보드 실행(기본 포트 6006) 및 트레이서 등록
session = px.launch_app()
tracer_provider = register(
    project_name="example-rag-pipeline-with-weaviate",
    endpoint="http://127.0.0.1:6006/v1/traces",
    auto_instrument=True  # OpenAI 호환 LLM 호출을 자동으로 감지해 트레이싱
)
tracer = tracer_provider.get_tracer(__name__)

# 2. 로컬 Weaviate 서버와 OpenAI 호환 추론 클라이언트 초기화
client = weaviate.connect_to_local(port=8079, grpc_port=50050)
llm_client = OpenAI(base_url="http://127.0.0.1:8000/v1", api_key="EMPTY")

# 3. 검색기 함수: Phoenix Retriever 탭에 검색된 문서를 표시하기 위해 수동 with 블록 사용
def retrieve(query_text: str, limit: int = 5):
    with tracer.start_as_current_span("query_weaviate", openinference_span_kind="retriever") as span:
        span.set_input(query_text)

        chunks = client.collections.get("Faq")
        results = chunks.query.near_text(query=query_text, limit=limit)

        # 검색된 각 문서의 UUID, 메타데이터, 본문을 OpenInference 표준 키로 기록
        for i, document in enumerate(results.objects):
            span.set_attribute(f"retrieval.documents.{i}.document.id", str(document.uuid))
            span.set_attribute(f"retrieval.documents.{i}.document.metadata", str(document.metadata))
            span.set_attribute(f"retrieval.documents.{i}.document.content", str(document.properties))

        return results

# 4. 컨텍스트 포맷팅 및 프롬프트 생성 함수: @tracer.chain 데코레이터로 간편 계측
@tracer.chain
def format_context(results) -> str:
    context = ""
    for item in results.objects:
        props = item.properties
        context += f"Question: {props['question']}\nAnswer: {props['answer']}\n"
    return context

@tracer.chain
def create_prompt(query_text: str, context: str) -> str:
    return f"""Based on the following information, please answer the FAQ related question: "{query_text}"

Relevant FAQ (ordered by relevance):
{context}"""

# 5. OpenAI 호환 LLM 호출 함수 (auto_instrument=True 덕분에 자동 추적됨)
def query_openai(prompt: str) -> str:
    response = llm_client.chat.completions.create(
        model="Qwen/Qwen3.5-9B",
        extra_body={"reasoning": False},
        messages=[
            {"role": "system", "content": "You are a helpful assistant from a customer support."},
            {"role": "user", "content": prompt},
        ],
    )
    return response.choices[0].message.content

# 6. 전체 RAG 파이프라인 실행 및 트레이스 기록
@tracer.chain
def rag_pipeline(query: str) -> str:
    retrieved_documents = retrieve(query)
    context = format_context(retrieved_documents)
    final_prompt = create_prompt(query, context)
    final_answer = query_openai(final_prompt)
    return final_answer

response = rag_pipeline("Can I get a refund or exchange for another shirt?")
print(response)
```

```text
Yes, you can get a refund or an exchange for your shirt! 

* **Timeframe:** We accept returns within **30 days of delivery**.
* **Exchanges:** You can initiate an exchange through our **Returns Center** by selecting the shirt you wish to exchange and choosing your desired replacement.
* **Shipping Costs:** If you are making a domestic return, we provide a **prepaid return label**.
* **Processing Time:** Once your returned shirt reaches our warehouse, it typically takes **5–7 business days** to process.
* **Exceptions:** Please note that if the shirt was a **sale item**, it is considered final sale and cannot be returned or exchanged unless stated otherwise.
```

---

## 7. 챗봇 비용과 속도 개선

이제 4편에서 구현했던 의류 쇼핑몰(`Fashion Forward Hub`) 에이전트 챗봇을 서비스 운영 기준에 맞게 고도화한다. 트래픽이 늘어나면서 **① 과도한 토큰 사용에 따른 비용 증가**와 **② 일부 질문의 느린 응답 속도**가 병목으로 떠올랐다.

이번 구현에서는 모든 핵심 함수에 Phoenix 트레이싱과 `(결과값, 사용_토큰수)` 집계 인터페이스를 적용한다. 여기에 **`simplified=True` 경량화 모드**를 추가해 **답변 품질은 유지하면서 토큰 소모와 불필요한 LLM 호출을 줄인다**. 아래 코드는 `llm_client`를 감싸 `usage`까지 반환하는 `generate_with_single_input`과 4편의 보조 함수가 준비된 환경을 전제로 한다.

### 1) OpenAI 표준 응답에서 토큰 사용량 추출하기

4편에서는 `generate_with_single_input`이 `{'role': ..., 'content': ...}` 딕셔너리만 반환했지만, 비용 집계를 위해 토큰 사용량(`usage`)까지 담긴 **OpenAI API 표준 응답 딕셔너리**를 반환하도록 확장한다.

```python
import json

# 단계별 LLM 호출 결과를 받아 응답 텍스트와 총 소모 토큰 수를 추출
result = generate_with_single_input("What are the primary colors?")
content = result['choices'][0]['message']['content']
total_tokens = result['usage']['total_tokens']
```

### 2) 경량화 구조 비교: 기존(`simplified=False`) vs 개선(`simplified=True`)

네 곳의 핵심 지점에서 토큰과 지연 시간을 어떻게 절감하는지 먼저 전체 구조를 대조한다.

| 최적화 지점 | 기존 방식 (`simplified=False`) | 경량화 방식 (`simplified=True`) | 핵심 이점 |
|---|---|---|---|
| **1차 의도 라우터** | 예시 8개가 포함된 장문 프롬프트 | 핵심 기준과 대표 예시 3개만 남긴 압축 프롬프트 | 분류 정확도를 유지하며 토큰 절반 수준 절감 |
| **FAQ 문맥 주입** | 25개 FAQ 전체 주입 (약 1,220 토큰) | Weaviate `near_text` 상위 5개 검색 주입 | 관련 문답만 선별해 토큰 약 68% 절감 |
| **2차 작업 라우터** | 장문 프롬프트 (약 200+ 토큰) | 경계 사례(`vibrant colors`)를 반영한 단문 프롬프트 | 150 토큰 미만으로 의도 정확도 유지 |
| **상품 검색** | LLM 메타데이터 필터 JSON 생성 + 완화 재검색 | LLM 필터 추출 생략 후 즉시 `near_text(limit=20)` | 필터 추출용 LLM 호출 1회와 약 1,500 토큰 제거 |

---

### 3) [개선 1] 1차 라우터 프롬프트 경량화 (`check_if_faq_or_product`)

기존(`simplified=False`) 1차 라우터 프롬프트는 설명과 8개 예시가 길어 질문 하나마다 많은 토큰을 소비한다. `simplified=True`일 때는 **핵심 분류 기준과 대표 예시 3개만 남겨 총 토큰 수(입력 + 출력)를 180 토큰 이하로 줄이면서도 동일한 분류 정확도를 유지**하도록 압축한다.

```python
def check_if_faq_or_product(query: str, simplified: bool = False) -> tuple[str, int]:
    """질문을 'FAQ' 또는 'Product'로 분류하고, 분류 라벨과 소모된 총 토큰 수를 함께 반환한다."""
    if not simplified:
        PROMPT = f"""Label the following instruction as an FAQ related answer or a product related answer for a clothing store.
        Product related answers are answers specific about product information or that needs to use the products to give an answer.
        Examples:
                Is there a refund for incorrectly bought clothes? Label: FAQ
                Where are your stores located?: Label: FAQ
                Tell me about the cheapest T-shirts that you have. Label: Product
                Do you have blue T-shirts under 100 dollars? Label: Product
                What are the available sizes for the t-shirts? Label: FAQ
                How can I contact you via phone? Label: FAQ
                How can I find the promotions? Label: FAQ
                Give me ideas for a sunny look. Label: Product
        Return only one of the two labels: FAQ or Product, nothing more.
        Query to classify: {query}"""
    else:
        # [개선 1] 불필요한 공백과 중복 예시를 제거하여 180 토큰 미만으로 압축한 프롬프트
        PROMPT = f"""Classify the clothing store query as FAQ or Product.
FAQ: refunds, returns, store locations, sizes, contact, promotions.
Product: specific clothing items, prices, availability, or outfit/look ideas.
Examples:
Is there a refund for incorrectly bought clothes? Label: FAQ
Do you have blue T-shirts under 100 dollars? Label: Product
Give me ideas for a sunny look. Label: Product
Return only one word: FAQ or Product.
Query: {query}"""

    # Phoenix 트레이싱 스팬 기록 및 LLM 호출
    with tracer.start_as_current_span("routing_faq_or_product", openinference_span_kind="tool") as span:
        span.set_input(str({"query": query, "simplified": simplified}))
        kwargs = generate_params_dict(PROMPT, model="Qwen/Qwen3.5-9B", temperature=0, max_tokens=10)

        with tracer.start_as_current_span("router_call", openinference_span_kind="llm") as router_span:
            router_span.set_input(kwargs)
            response = generate_with_single_input(**kwargs)
            # OpenInference 비용 계산용 토큰 속성 기록
            router_span.set_attribute("llm.token_count.prompt", response['usage']['prompt_tokens'])
            router_span.set_attribute("llm.token_count.completion", response['usage']['completion_tokens'])
            router_span.set_attribute("llm.token_count.total", response['usage']['total_tokens'])
            router_span.set_attribute("llm.model_name", response['model'])
            router_span.set_output(response)
            router_span.set_status(Status(StatusCode.OK))

        # OpenAI 응답 객체에서 텍스트와 총 토큰 수 추출
        label = response['choices'][0]['message']['content']
        total_tokens = response['usage']['total_tokens']

        # 모델이 한 단어 이상 출력하더라도 안전하게 라벨을 정제하는 방어 로직
        if 'faq' in label.lower():
            label = 'FAQ'
        elif 'product' in label.lower():
            label = 'Product'
        else:
            label = 'undefined'

        span.set_output(str({"label": label, "total_tokens": total_tokens}))
        span.set_status(Status(StatusCode.OK))
        return label, total_tokens

# 기존 방식 vs 경량화 방식의 정확도 및 토큰 수 비교
test_queries = [
    'What is your return policy?',
    'Give me three examples of blue T-shirts you have available.',
    'How can I contact the user support?',
    'Do you have blue Dresses?',
    'Create a look suitable for a wedding party happening during dawn.'
]
for q in test_queries:
    lbl_std, tok_std = check_if_faq_or_product(q, simplified=False)
    lbl_simp, tok_simp = check_if_faq_or_product(q, simplified=True)
    print(f"[{lbl_std} == {lbl_simp}] 토큰 수 변화: {tok_std} -> {tok_simp} | Query: {q}")
```

```text
[FAQ == FAQ] 토큰 수 변화: 186 -> 98 | Query: What is your return policy?
[Product == Product] 토큰 수 변화: 192 -> 104 | Query: Give me three examples of blue T-shirts you have available.
[FAQ == FAQ] 토큰 수 변화: 187 -> 99 | Query: How can I contact the user support?
[Product == Product] 토큰 수 변화: 186 -> 98 | Query: Do you have blue Dresses?
[Product == Product] 토큰 수 변화: 192 -> 104 | Query: Create a look suitable for a wedding party happening during dawn.
```

5개 질문 모두 분류 결과는 100% 일치하면서 라우터 호출당 토큰 수가 **약 190 토큰에서 100 토큰 내외로 절반 가까이 절감**되었다.

> [!NOTE]
> **수동으로 `router_span`을 기록하는 이유**
> 6장에서는 `register(..., auto_instrument=True)`로 모든 LLM 호출을 자동 추적했다. 반면 챗봇 함수에서는 단위 테스트나 별도 실험용 호출이 대시보드에 섞이는 것을 막기 위해 자동 계측을 끄고, 추적이 필요한 함수 안에서 `openinference_span_kind="llm"` 스팬을 직접 연다. 여기에 **OpenInference 시맨틱 컨벤션(Semantic Conventions)** 표준 키(`llm.token_count.prompt`, `llm.token_count.completion`, `llm.token_count.total`, `llm.model_name`, `llm.provider`)를 남기면, Phoenix UI의 **`/settings/models` 메뉴**에 모델별 입력과 출력 단가를 등록했을 때 실제 달러(\$) 비용이 자동 합산된다.

---

### 4) [개선 2] FAQ 전체 주입에서 Weaviate Top-5 시맨틱 검색으로 전환 (`query_on_faq`)

4편(`simplified=False`)에서는 25개 FAQ 전체를 문자열로 만들어 프롬프트에 통째로 넣었기 때문에, 간단한 반품 질문 하나에도 **약 1,220 토큰**이 소모되었다. 이제 25개 FAQ를 Weaviate의 `faq_collection`(`"Faq"`)에 인덱싱해 두고, `simplified=True`일 때는 **`faq_collection.query.near_text(query, limit=5)`로 질문과 가장 관련된 상위 5개 FAQ만 검색해 주입**하도록 개선한다.

```python
from weaviate.util import generate_uuid5

# 1. Weaviate 'Faq' 컬렉션에 25개 FAQ 문답 배치 인덱싱
faq_collection = client.collections.get("Faq")
with faq_collection.batch.fixed_size(batch_size=20, concurrent_requests=5) as batch:
    for document in FAQ:
        batch.add_object(properties=document, uuid=generate_uuid5(document['question']))

# 2. simplified=True 시 상위 5개 FAQ만 검색하여 프롬프트를 조립하는 함수
def query_on_faq(query: str, simplified: bool = False, **kwargs) -> dict:
    if not simplified:
        # 기존 방식: 25개 FAQ 전체를 프롬프트에 주입
        with tracer.start_as_current_span("query_on_faq", openinference_span_kind="tool") as span:
            faq_layout = generate_faq_layout(FAQ)
            PROMPT = f"""You will be provided with an FAQ for a clothing store. 
        Answer the instruction based on it. You might use more than one question and answer to make your answer. Only answer the question and do not mention that you have access to a FAQ. 
        <FAQ_ITEMS>
        PROVIDED FAQ: {faq_layout}
        </FAQ_ITEMS>
        Question: {query}"""
            params = generate_params_dict(PROMPT, **kwargs)
            span.set_status(Status(StatusCode.OK))
            return params
    else:
        # [개선 2] 경량화 방식: Weaviate 시맨틱 검색으로 상위 5개 FAQ만 추출하여 주입
        with tracer.start_as_current_span("query_on_faq", openinference_span_kind="tool") as span:
            with tracer.start_as_current_span("retrieve_faq_questions", openinference_span_kind="retriever") as retrieve_span:
                # 상위 5개 관련 FAQ 시맨틱 검색
                results = faq_collection.query.near_text(query, limit=5)

                for i, document in enumerate(results.objects):
                    retrieve_span.set_attribute(f"retrieval.documents.{i}.document.id", str(document.uuid))
                    retrieve_span.set_attribute(f"retrieval.documents.{i}.document.content", str(document.properties))

                # 검색 객체에서 실제 딕셔너리(.properties) 리스트를 추출한 뒤 역순 정렬(.reverse())
                results_list = [x.properties for x in results.objects]
                results_list.reverse()
                faq_layout = generate_faq_layout(results_list)

            PROMPT = (
                f"You will be provided with a query for a clothing store regarding FAQ. Relevant FAQs from the store are listed below.\n"
                f"They are ordered in increasing relevance, so the last item nearest to the query is the most relevant FAQ.\n"
                f"Answer the instruction based on them. You might use more than one question and answer to make your answer. Only answer the question and do not mention that you have access to a FAQ.\n"
                f"<FAQ>\nRELEVANT FAQ ITEMS:\n{faq_layout}\n</FAQ>\n"
                f"Query: {query}"
            )
            params = generate_params_dict(PROMPT, **kwargs)
            span.set_status(Status(StatusCode.OK))
            return params

# FAQ 전체 주입(simplified=False) vs Top-5 검색 주입(simplified=True) 토큰 수 비교
q_faq = "I received the dress I ordered but I don't like it. How can I return it?"
res_full = generate_with_single_input(**query_on_faq(q_faq, simplified=False))
res_simp = generate_with_single_input(**query_on_faq(q_faq, simplified=True))

print("기존 방식(전체 FAQ) 총 토큰 수:", res_full['usage']['total_tokens'])
print("개선 방식(Top-5 FAQ) 총 토큰 수:", res_simp['usage']['total_tokens'])
print("\n[개선 방식 생성 답변]:\n", res_simp['choices'][0]['message']['content'])
```

```text
기존 방식(전체 FAQ) 총 토큰 수: 1218
개선 방식(Top-5 FAQ) 총 토큰 수: 384

[개선 방식 생성 답변]:
You can return the dress within 30 days of delivery, provided it is not a final sale item. To make the return:

1. Initiate the return through our Returns Center.
2. If you are making a domestic return, we will provide a prepaid return shipping label (for international returns, shipping is at your cost).
3. Once your return is received at our warehouse, please allow 5-7 business days for processing.
```

25개 전체 대신 상위 5개 FAQ만 검색해 넣음으로써 답변의 정확도는 그대로 유지하면서 총 토큰 수를 **1,218 토큰에서 384 토큰으로 약 68% 절감**했다.

여기서 눈여겨볼 두 가지 코드 디테일이 있다:
- **왜 검색 결과를 `.reverse()`로 뒤집고 프롬프트 설명도 맞췄을까?**: `near_text(query, limit=5)`는 가장 관련성이 높은 1위 문서를 맨 앞(0번)에, 5위 문서를 맨 뒤(4번)에 담아 반환한다. LLM은 입력 프롬프트의 맨 끝(`Query:` 직전)에 놓인 문맥에 더 높은 주의(Attention)를 기울이는 최신성 편향(Recency bias)이 있다. 따라서 `results_list.reverse()`로 순서를 뒤집어 1위 FAQ를 질문 바로 위에 두고, 프롬프트 지시문 역시 마지막 항목이 가장 관련성이 높다고 일치시켜 모델의 혼선을 없앴다.
- **단어 수(`len(prompt.split())`)와 실제 토큰 수(`total_tokens`)의 차이**: 파이썬의 `.split()`으로 공백 기준 단어 수를 세어 보면 실제 LLM이 청구하는 토큰 수보다 적게 나온다. LLM의 토크나이저(Tokenizer)는 단순 공백 단위가 아니라 **서브워드(Subword)와 문장 부호 단위로 텍스트를 더 잘게 쪼개기 때문**에, 비용을 정확히 계산하려면 반드시 단어 수가 아닌 API 응답의 `usage['total_tokens']`를 기준으로 삼아야 한다.

---

### 5) [개선 3] 2차 라우터(`technical` vs `creative`) 프롬프트 다이어트 (`decide_task_nature`)

상품 질문을 사실 조회(`technical`)와 코디 추천(`creative`)으로 나누는 2차 라우터 역시 `simplified=True`일 때 **150 토큰 미만**으로 작동하도록 프롬프트를 압축한다. 이때 `"Give me two sneakers with vibrant colors."`처럼 색상이 화려한 상품을 단순 조회하는 질문이 `creative`로 잘못 분류되는 경계 사례가 나타날 수 있다. 이를 막기 위해 **특정 조건의 카탈로그 상품 조회는 `technical`이고 코디와 매칭 제안만 `creative`**라는 기준을 예시와 함께 명확히 적는다.

```python
def decide_task_nature(query: str, simplified: bool = False) -> tuple[str, int]:
    """상품 질문을 'creative' 또는 'technical'로 분류하고 소모된 총 토큰 수를 함께 반환한다."""
    if not simplified:
        PROMPT = f"""Decide if the following query is a query that requires creativity (creating, composing, making new things) or technical (information about products, prices etc.). Label it as creative or technical.
          Examples:
          Give me suggestions on a nice look for a nightclub. Label: creative
          What are the blue dresses you have available? Label: technical
          Give me three Tshirts for summer. Label: technical
          Give me a look for attending a wedding party. Label: creative
          Give me suggestions on clothes that match a green Tshirt. Label: creative
          I would like a suggestion on which products match a green Tshirt I already have. Label: creative

          Query to be analyzed: {query}. Only output one token with the label"""
    else:
        # [개선 3] 150 토큰 미만으로 압축하되 'vibrant colors' 단순 상품 조회 경계 사례를 반영한 프롬프트
        PROMPT = f"""Label the clothing query as creative or technical.
creative: creating a look, outfit ideas, or matching accessories with clothes.
technical: finding specific products, colors, quantities, or prices in the catalogue.
Examples:
Give me two sneakers with vibrant colors. Label: technical
I have a green Dress and want an accessory to match it. Label: creative
Create a look for walking in a park. Label: creative
Output only one token: creative or technical.
Query: {query}"""

    with tracer.start_as_current_span("decide_task_nature", openinference_span_kind="tool") as span:
        span.set_input(str({"query": query, "simplified": simplified}))
        kwargs = generate_params_dict(PROMPT, model="Qwen/Qwen3.5-9B", temperature=0, max_tokens=1)
        with tracer.start_as_current_span("router_call", openinference_span_kind="llm") as router_span:
            router_span.set_input(kwargs)
            response = generate_with_single_input(**kwargs)
            usage = response.get('usage', {})
            router_span.set_attribute("llm.model_name", response.get('model', kwargs.get('model')))
            router_span.set_attribute("llm.token_count.prompt", usage.get('prompt_tokens', 0))
            router_span.set_attribute("llm.token_count.completion", usage.get('completion_tokens', 0))
            router_span.set_attribute("llm.token_count.total", usage.get('total_tokens', 0))
            router_span.set_output(response)
            router_span.set_status(Status(StatusCode.OK))

        raw_label = response['choices'][0]['message']['content'].strip().lower()
        # 경량 모델 응답에 구두점이나 부가 설명이 섞여도 'technical'/'creative' 라벨을 안전하게 정규화
        if 'technical' in raw_label:
            label = 'technical'
        elif 'creative' in raw_label:
            label = 'creative'
        else:
            # 판별 불가 응답은 검색 기반 정합성이 우선되는 'technical' 경로로 폴백
            label = 'technical'

        total_tokens = usage.get('total_tokens', 0)
        span.set_output(str({"label": label, "total_tokens": total_tokens}))
        span.set_status(Status(StatusCode.OK))
        return label, total_tokens
```

---

### 6) [개선 4] 메타데이터 추출 LLM 호출 생략 및 최종 오케스트레이터 비교 (`get_relevant_products_from_query` & `answer_query`)

기존 상품 검색 파이프라인(`simplified=False`)에서 가장 많은 토큰과 지연 시간을 잡아먹던 주범은 시맨틱 검색 전에 호출하던 **`generate_metadata_from_query(query)`**였다. 허용 가능한 모든 카테고리 고유값 집합(`{values}`)을 프롬프트에 넣어 JSON 필터를 생성하느라 **검색 전 단계에서만 무려 약 1,500 토큰과 추가 LLM 호출 지연 시간**이 발생했다.

하지만 Weaviate의 `near_text()` 임베딩 검색은 자연어 질문 자체의 문맥(성별, 계절, 색상, 품목 등)을 벡터 유사도로 잘 포착한다. 따라서 `simplified=True`일 때는 **LLM을 통한 메타데이터 필터 생성을 생략(소모 토큰 0개)하고, 곧바로 `products_collection.query.near_text(query, limit=20)`으로 20개의 상품을 시맨틱 검색**하여 반환한다. 다만 `"100달러 이하"`, `"빨간색 제외"`처럼 정확한 수치 범위나 부정 조건을 반드시 지켜야 하는 질문에서는 순수 시맨틱 검색만으로는 조건 밖 상품이 섞일 수 있다. 그런 엄격한 필터링이 중요한 질의라면 경량 규칙 파서나 하이브리드 필터링을 병행해야 한다.

```python
def generate_filters_from_query_with_usage(query: str) -> tuple[list | None, int]:
    """4편 허용값 주입 프롬프트를 OpenAI 호환 형식으로 호출해 (Filter 리스트, 소모 토큰)을 반환한다."""
    prompt = build_metadata_prompt(query, values)
    kwargs = generate_params_dict(prompt, model="Qwen/Qwen3.5-9B", temperature=0, max_tokens=1500)
    response = generate_with_single_input(**kwargs)
    content = response['choices'][0]['message']['content']
    total_tokens = response.get('usage', {}).get('total_tokens', 0)
    return get_filter_by_metadata(parse_json_output(content)), total_tokens

def get_relevant_products_from_query(query: str, simplified: bool = False) -> tuple[list, int]:
    """
    상품을 검색하여 (상품 객체 리스트, 검색 과정에서 소모된 LLM 토큰 수)를 반환한다.
    simplified=True이면 LLM 메타데이터 추출을 생략하고 즉시 순수 시맨틱 검색을 수행한다(토큰 소모 0).
    """
    if simplified:
        with tracer.start_as_current_span("get_relevant_products_from_query", openinference_span_kind="retriever") as span:
            span.set_input({'query': query, 'simplified': simplified})

            # [개선 4] LLM 필터 생성 없이 곧바로 products_collection에서 상위 20개 시맨틱 검색 수행
            results = products_collection.query.near_text(query, limit=20)

            for i, document in enumerate(results.objects):
                span.set_attribute(f"retrieval.documents.{i}.document.id", str(document.uuid))
                span.set_attribute(f"retrieval.documents.{i}.document.content", str(document.properties))

            span.set_output({"results": results.objects, "total_tokens": 0})
            span.set_status(Status(StatusCode.OK))
            # LLM을 호출하지 않았으므로 소모된 토큰 수 자리에 0을 반환한다!
            return results.objects, 0

    # simplified=False일 때: 기존 방식대로 LLM으로 메타데이터 JSON 필터를 생성(약 1,500 토큰 소모)한 뒤 검색
    with tracer.start_as_current_span("get_relevant_products_from_query", openinference_span_kind="retriever") as span:
        span.set_input({'query': query, 'simplified': simplified})
        filters, total_tokens = generate_filters_from_query_with_usage(query)
        span.set_attribute("retrieval.token_cost", total_tokens)

        # JSON 파싱 실패나 빈 필터 결과일 때는 필터 없는 순수 시맨틱 검색으로 바로 폴백
        if filters is None or len(filters) == 0:
            results = products_collection.query.near_text(query, limit=20)
            span.set_output({"results": results.objects, "total_tokens": total_tokens, "fallback": "no_filter"})
            span.set_status(Status(StatusCode.OK))
            return results.objects, total_tokens

        results = products_collection.query.near_text(query, filters=Filter.all_of(filters), limit=20)
        # 구체적 속성부터 핵심 속성(baseColour) 순서로 필터를 완화해 0건 반환 방지
        drop_order = ['gender', 'season', 'usage', 'articleType', 'masterCategory', 'baseColour']
        if len(results.objects) < 10:
            for i in range(len(drop_order)):
                dropped = set(drop_order[:i + 1])
                relaxed = [x for x in filters if x.target not in dropped]
                # 완화 후 남는 필터 조건이 없으면 빈 Filter.all_of([]) 호출을 막기 위해 루프 종료
                if not relaxed:
                    break
                results = products_collection.query.near_text(
                    query, filters=Filter.all_of(relaxed), limit=20
                )
                # 최소 5건 이상 후보를 확보하면 과도한 필터 완화를 멈추고 즉시 반환
                if len(results.objects) >= 5:
                    span.set_output({"results": results.objects, "total_tokens": total_tokens, "relaxed_step": i + 1})
                    span.set_status(Status(StatusCode.OK))
                    return results.objects, total_tokens
            # 모든 필터 완화 단계에서도 5건 미만이면 필터를 전면 해제한 순수 시맨틱 검색으로 폴백
            if len(results.objects) < 5:
                results = products_collection.query.near_text(query, limit=20)

        span.set_output({"results": results.objects, "total_tokens": total_tokens})
        span.set_status(Status(StatusCode.OK))
        return results.objects, total_tokens
```

이제 각 단계에서 사용한 토큰 수를 모두 합산(`total_tokens += tokens`)하며 최종 LLM 호출용 파라미터를 조립하는 `query_on_products`와 최종 오케스트레이터 `answer_query`를 연결하고, `simplified=False`와 `simplified=True`의 전체 토큰 사용량을 비교한다.

```python
@tracer.tool
def query_on_products(query: str, simplified: bool = False) -> tuple[dict, int]:
    total_tokens = 0
    # 1. 2차 라우터 호출 및 토큰 합산
    query_label, tokens = decide_task_nature(query, simplified=simplified)
    total_tokens += tokens
    parameters_dict = get_params_for_task(query_label)

    # 2. 상품 검색 및 토큰 합산 (simplified=True이면 tokens는 0)
    relevant_products, tokens = get_relevant_products_from_query(query, simplified=simplified)
    total_tokens += tokens
    context = generate_items_context(relevant_products)

    # 3. 최종 증강 프롬프트 조립
    PROMPT = (
        f"Given the available set of clothing products given by: "
        f"CLOTHING PRODUCTS AVAILABLE:\n{context}\n"
        f"Answer the question that follows.\n"
        f"Never use more than 5 clothing products available below to compose your answer.\n"
        f"Provide the item ID in your answers.\n"
        f"The other information might be provided but not necessarily all of them, pick only the relevant ones for the given query.\n"
        f"QUERY: {query}"
    )
    kwargs = generate_params_dict(PROMPT, role='assistant', **parameters_dict)
    return kwargs, total_tokens

@tracer.tool
def answer_query(
    query: str,
    model: str = "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    simplified: bool = False
) -> tuple[dict, int]:
    """전체 라우팅 및 검색 워크플로를 실행하고 (최종 호출 kwargs, 누적 중간 토큰 수)를 반환한다."""
    total_tokens = 0
    label, tokens = check_if_faq_or_product(query, simplified=simplified)
    total_tokens += tokens

    # 1차 의도가 FAQ/Product 범주 밖이면 검색 없이 안내 프롬프트로 안전 폴백
    if label not in ['FAQ', 'Product']:
        return {
            "role": "assistant",
            "prompt": f"User provided a question that does not fit FAQ or Product-related categories. Answer it based on the context you already have. Query provided by the user: {query}"
        }, total_tokens

    # FAQ 경로: 상점 정책과 주문 절차 문맥을 조립해 LLM 파라미터 생성
    if label == 'FAQ':
        kwargs = query_on_faq(query, simplified=simplified)
    # Product 경로: 상품 검색이나 LLM 호출 실패 시 전체 파이프라인 중단 대신 재질문 유도 폴백 반환
    elif label == 'Product':
        try:
            kwargs, tokens = query_on_products(query, simplified=simplified)
            total_tokens += tokens
        except Exception:
            return {
                "role": "assistant",
                "prompt": f"User provided a question that broke the querying system. Instruct them to rephrase it. Answer it based on the context you already have. Query provided by the user: {query}"
            }, total_tokens

    # 최종 답변 생성에는 고성능 모델(70B)을 지정하고, 앞선 라우팅 단계들은 경량 모델(9B)로 처리하여 비용을 최적화함
    kwargs['model'] = model
    return kwargs, total_tokens

# [최종 비교 검증] 동일한 상품 질문에 대해 기존 방식(False) vs 경량화 방식(True) 실행
test_q = "Give me three examples of blue t-shirts available on your catalogue."

# 1) 기존 방식 (simplified=False)
kwargs_old, prep_tokens_old = answer_query(test_q, simplified=False)
res_old = generate_with_single_input(**kwargs_old)
grand_total_old = prep_tokens_old + res_old['usage']['total_tokens']

# 2) 경량화 방식 (simplified=True)
kwargs_new, prep_tokens_new = answer_query(test_q, simplified=True)
res_new = generate_with_single_input(**kwargs_new)
grand_total_new = prep_tokens_new + res_new['usage']['total_tokens']

print(f"기존 방식(simplified=False) 총 토큰: {grand_total_old} (준비 단계: {prep_tokens_old} + 최종 생성: {res_old['usage']['total_tokens']})")
print(f"개선 방식(simplified=True)  총 토큰: {grand_total_new} (준비 단계: {prep_tokens_new} + 최종 생성: {res_new['usage']['total_tokens']})")
print("\n[개선 방식 최종 답변]:\n", res_new['choices'][0]['message']['content'])
```

```text
기존 방식(simplified=False) 총 토큰: 2945 (준비 단계: 1852 + 최종 생성: 1093)
개선 방식(simplified=True)  총 토큰: 1284 (준비 단계: 196 + 최종 생성: 1088)

[개선 방식 최종 답변]:
Here are three examples of blue T-shirts available in our catalogue:

1. **Locomotive Men Washed Blue T-shirt** (Product ID: 3318) – A casual men's summer topwear piece in a washed blue shade.
2. **ADIDAS Men Solid Blue T-shirt** (Product ID: 1844) – A sporty, solid blue T-shirt designed for men.
3. **Puma Men Rebel Basic Blue T-shirt** (Product ID: 1866) – A classic casual blue T-shirt suitable for everyday wear.
```

최종 실행 결과를 보면 다음과 같은 비용과 지연 시간 최적화 효과를 확인할 수 있다:
1. **라우터 경량화와 불필요한 LLM 호출 제거**: 프롬프트 생성 전 준비 단계(`prep_tokens`)에서 소모되던 토큰이 **1,852 토큰에서 196 토큰으로 약 89% 감소**했으며, 메타데이터 추출을 위한 LLM 왕복 호출이 사라져 응답 지연 시간도 크게 단축되었다.
2. **모델 크기 이원화(Model Tiering)**: 단순 분류를 수행하는 1차와 2차 라우터는 가벼운 소형 모델(`Qwen/Qwen3.5-9B`)로 빠르게 처리한다. 반면 마지막 `answer_query`에서 최종 고객 답변을 작성할 때만 고성능 모델(`Llama-3.3-70B-Instruct-Turbo`)을 지정해 비용과 품질의 균형을 맞춘다.

---

## 8. 참고 자료

- DeepLearning.AI — *Retrieval Augmented Generation (RAG)*, Module 5: Production RAG Optimization and Multimodal Retrieval
