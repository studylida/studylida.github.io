---
title: "RAG 파이프라인 4편: LLM 텍스트 생성 제어와 에이전트 기반 RAG 챗봇 구현"
description: "트랜스포머 디코더 원리와 샘플링 제어부터 프롬프트 설계, 환각 억제와 RAGAS 평가, 동적 필터링을 결합한 에이전트 RAG 구현까지 정리한다."
pubDate: "2026-11-12 12:30:00"
tags: ["RAG", "LLM", "Sampling", "PromptEngineering", "Hallucination", "RAGAS", "AgenticRAG", "Weaviate"]
categories: ["AI", "Python"]
draft: false
---

검색기가 지식베이스에서 질문과 관련된 문서를 찾아왔더라도, 최종 답변을 작성하는 주체는 대규모 언어 모델(LLM)이다. 이번 글에서는 증강 프롬프트가 트랜스포머 디코더 내부에서 어떻게 처리되는지 살펴보고, 샘플링 파라미터 조절과 프롬프트 설계, 환각 억제 및 RAGAS 평가 기법을 정리한다. 후반부에서는 이 기법들을 묶어 질문 라우팅과 동적 메타데이터 필터링을 수행하는 의류 쇼핑몰 에이전트 RAG 챗봇을 구현한다.

---

## 1. 트랜스포머와 토큰 생성

RAG 파이프라인에서 검색된 문서 조각과 사용자의 질문을 합쳐 LLM에 전달하면, 모델은 문맥을 파악해 답변을 한 단어씩 생성한다. 이 과정을 이해하려면 2017년 "Attention Is All You Need" 논문에서 제안된 트랜스포머(Transformer) 아키텍처의 내부 동작을 살펴보아야 한다.

트랜스포머는 원래 독일어 문단을 영어 문단으로 번역하는 기계 번역 문제를 풀기 위해 고안되었으며, 크게 두 부분으로 나뉜다.
- **인코더(Encoder)**: 원본 텍스트를 읽고 문맥의 의미를 압축한 표현(Representation)을 만든다. 텍스트 의미를 벡터로 바꾸는 것이 목적이므로 주로 **임베딩 모델(Embedding Model)** 내부에 사용된다.
- **디코더(Decoder)**: 파악한 의미를 바탕으로 새로운 텍스트를 한 토큰씩 생성한다. 텍스트 생성이 목적인 대부분의 **생성형 LLM**은 이 디코더 구조만을 사용한다.

### 프롬프트가 트랜스포머 디코더를 통과하는 6단계

증강 프롬프트가 LLM 디코더 계층을 통과하며 다음 토큰 하나를 만들어내기까지는 여섯 단계를 거친다.

1. **토큰화 및 초기 정적 임베딩(First-guess Vector)**: 입력 프롬프트 문자열을 단어 또는 서브워드 단위의 토큰으로 분할한다. 각 토큰에는 사전 학습된 고정 밀집 벡터가 할당된다. 이 초기 벡터는 주변 문맥이 반영되지 않은 첫 번째 추측값으로, 같은 토큰이면 어떤 문장에서든 동일한 초기 벡터를 받는다.
2. **위치 벡터(Positional Vector) 결합**: 자연어는 어순에 따라 의미가 달라진다. 따라서 각 토큰이 프롬프트 내 몇 번째 위치인지 나타내는 위치 벡터를 초기 임베딩 벡터에 더한다.
3. **멀티 헤드 어텐션(Multi-Head Attention)**: 토큰들이 어텐션 계층에 진입하면 각 토큰은 프롬프트 안의 다른 모든 토큰을 참조한다. 이를 통해 자신의 의미를 구체화할 때 어떤 토큰에 얼마나 큰 비중(Attention)을 두어야 하는지 계산한다.

![트랜스포머 어텐션 가중치 배분 예시](/images/rag/module4/transformer_attention.png)

예를 들어 `"the brown dog sat next to the red fox"`에서 `"dog"` 토큰은 자신을 수식하는 `"brown"`에 70%, 동작을 나타내는 `"sat"`에 20% 가중치를 두고 나머지 10%를 다른 토큰들에 배분한다.

이때 단어 간 관계를 계산하는 단위를 **어텐션 헤드(Attention Head)**라고 부른다. 단어 사이 관계는 여러 종류이므로 대부분의 LLM은 여러 어텐션 헤드를 병렬로 사용한다. 예컨대 한 헤드는 수식 관계를, 다른 헤드는 공간적 위치 관계를 포착한다. 실제로는 모델이 학습 과정에서 추상적인 문맥 관계를 스스로 익히며, 소형 모델은 8\~16개, 대형 모델은 100개 이상의 헤드를 동시에 가동해 문맥을 파악한다.

4. **피드포워드 계층(Feed-Forward Phase)**: 어텐션 계산이 끝나면 LLM 파라미터의 대다수가 집중된 피드포워드 계층으로 넘어간다. 여기에는 모델이 사전 학습으로 습득한 배경지식(World Knowledge)이 저장되어 있다. 각 토큰의 초기 임베딩과 위치, 어텐션 결과를 종합해 주변 문맥이 반영된 새 벡터(두 번째 추측값)로 갱신한다.
5. **다층 반복 정제(Iterative Refinement)**: 갱신된 벡터는 다시 다음 층의 어텐션과 피드포워드 계층으로 입력되어 다듬어진다.

![어텐션과 피드포워드 계층의 다층 반복 정제](/images/rag/module4/transformer_layers.png)

일반적인 LLM은 이 `[어텐션 ➔ 피드포워드]` 블록을 **8번에서 64번** 반복 통과시키며 각 토큰의 문맥 의미를 정교하게 만든다.

6. **다음 토큰 확률 분포 산출 및 자기회귀(Autoregressive) 생성**: 마지막 층을 통과해 정제된 벡터를 바탕으로, 모델은 전체 어휘 사전(예: 100,000개 토큰) 각각에 대해 다음에 등장할 확률 분포를 계산한다. 이론상 모든 토큰에 0에 가까운 미세한 확률이라도 부여된다.
   - 모델은 이 확률 분포에 따라 가중 무작위 선택으로 **단 1개의 토큰**을 뽑아 프롬프트 끝에 이어 붙인다.
   - 두 번째 토큰을 생성할 때는 방금 붙인 첫 토큰까지 포함해 **1단계부터 6단계까지 전체 과정을 처음부터 다시 반복**한다. 따라서 초반에 뽑힌 토큰 하나가 뒤이어 생성될 모든 토큰 분포에 연쇄적으로 영향을 미친다.
   - 이 반복 루프는 최대 토큰 수(`max_tokens`)에 도달하거나 모델이 종료 토큰(Stop token)을 선택할 때까지 계속된 뒤 최종 텍스트로 변환된다.

### 트랜스포머 구조가 RAG 설계에 주는 3가지 시사점

1. **RAG가 작동하는 원리**: 어텐션 메커니즘이 프롬프트에 추가된 검색 문서와 질문 사이의 관계를 연결하고, 피드포워드 계층의 배경지식이 이를 해석해 외부 문서를 읽고 답할 수 있다.
2. **근거 문서를 주어도 환각이 발생하는 이유**: 마지막 토큰 선택 단계가 확률 기반 무작위 추출이므로 정확한 문서를 주더라도 근거와 무관한 토큰이 뽑힐 여지가 항상 존재한다.
3. **프롬프트 길이와 연산 비용의 관계**: 어텐션 계층에서 모든 토큰이 상호 참조하고 토큰마다 전체 과정을 반복하므로 프롬프트나 생성 답변이 길어질수록 지연 시간과 비용이 커진다.

---

## 2. 샘플링과 파라미터 제어

LLM이 다음 토큰을 고를 때 쓰는 확률 분포 곡선은 상황에 따라 모양이 달라진다. `"The sky is"` 뒤에는 `"blue"`(50%), `"bright"`(25%)처럼 소수 토큰에 확률이 몰린 뾰족한 분포가 나온다. 반면 여러 전개가 가능한 문맥에서는 많은 토큰이 비슷한 확률을 나누어 갖는 평평한 분포가 나타난다.

작업 목적에 맞게 확률 분포에서 토큰을 선택하는 샘플링(Sampling) 전략을 살펴본다.

### 1) 그리디 디코딩(Greedy Decoding)

무작위 선택을 배제하고 매 단계 **확률이 가장 높은 1위 토큰만 선택**하는 방식이다(`temperature = 0`, `top_p = 0`, 또는 `top_k = 0`).
- **장점**: 항상 동일한 토큰만 고르므로 출력이 재현 가능하고 일관적이다. 같은 프롬프트를 넣으면 언제나 똑같은 응답이 나와 코드 완성이나 디버깅에 유용하다.
- **단점**: 문장이 단조로우며, 모델이 `"which the data confirms, which the data confirms..."`처럼 **동일 구절 반복 루프에 한 번 빠지면 계속 최고 확률 토큰만 고르므로 빠져나오지 못한다.**

### 2) Temperature: 확률 분포의 모양 변형

무작위성을 적절히 조절할 때 쓰는 파라미터가 `temperature`다. `temperature`는 토큰의 확률 순위는 바꾸지 않으면서 확률 분포 곡선을 더 뾰족하게 만들거나 평평하게 누른다.

![Temperature 값에 따른 토큰 확률 분포 변화](/images/rag/module4/sampling_temperature.png)

원래 토큰 확률이 $p_i$일 때, `temperature`($T$)를 적용한 확률은 로그 확률을 $T$로 나눈 뒤 소프트맥스 정규화를 거쳐 계산된다.

$$\mathrm{adjusted\_probability}(p_i) = \frac{\exp(\log(p_i) / T)}{\sum_{j} \exp(\log(p_j) / T)}$$

원래 확률 벡터가 $[0.6, 0.3, 0.1]$일 때 `temperature` 값에 따른 확률 변화는 다음과 같다.
- **`temperature = 0.5` ($T < 1$)**: **$[0.77, 0.18, 0.05]$**가 되어 1위 토큰 확률이 높아지고 사실 기반 질의응답에 적합한 일관된 출력을 만든다.
- **`temperature = 1.0` (기본값)**: **$[0.6, 0.3, 0.1]$** 그대로 유지된다. `temperature = 1`이 항상 같은 출력을 내는 설정은 아니며, 낮은 확률의 토큰도 뽑힐 수 있다.
- **`temperature = 2.0` ($T > 1$)**: **$[0.49, 0.27, 0.24]$**로 평평해져 하위 토큰 선택 가능성이 커진다. $1.1\sim1.3$ 수준으로 살짝 높이면 표현이 다채로워지지만, 지나치게 높이면 모든 단어 확률이 비슷해져 문맥이 무너진다.

> [!NOTE]
> **Temperature를 과도하게 높이면 답변 길이까지 길어지는 이유**
> LLM이 생성을 멈추는 조건은 `max_tokens` 도달 또는 **종료 토큰(Stop token)** 선택 두 가지뿐이다. `temperature`를 `2~3` 이상으로 높여 분포가 평평해지면 문장을 끝낼 시점에도 종료 토큰 확률이 다른 일반 단어들과 비슷하게 낮아진다. 그 결과 종료 토큰을 뽑지 못하고 `max_tokens` 상한선에 부딪힐 때까지 무의미한 문장을 길게 이어가게 된다.

### 3) Top-k vs Top-p (Nucleus Sampling): 확률 분포의 긴 꼬리 절단

`temperature`를 어떻게 설정하든 분포 오른쪽 끝에는 문맥과 어긋나는 수많은 토큰이 미세한 확률로 남는다. 이 꼬리 영역 토큰들을 후보에서 잘라내는 기법이 **Top-k**와 **Top-p**다.

- **Top-k 샘플링**: 확률 상위 $k$개(예: `top_k = 5`) 토큰만 후보로 남기고 나머지를 배제한다. 구현이 단순하지만 분포 모양과 무관하게 **항상 고정된 개수($k$개)**만 허용하는 한계가 있다.
- **Top-p (Nucleus) 샘플링**: 확률이 높은 토큰부터 더해 **누적 확률이 임계치 $p$($0 \le p \le 1$, 예: `top_p = 0.85`)에 도달할 때까지만** 후보에 포함한다.

![Top-p 누적 확률 기반 후보 토큰 선택 원리](/images/rag/module4/sampling_top_p.png)

Top-p는 분포 모양에 따라 동적으로 작동한다. 모델이 다음 단어를 **확신할 때**는 상위 `1~2`개 토큰만으로 85%를 넘어 후보를 좁힌다. 반대로 **불확실할 때**는 85%를 채울 때까지 더 많은 후보를 열어준다.

또한 `temperature`와 `top_p`를 함께 조합하면 시너지가 난다. `temperature`를 $1.1\sim1.3$으로 높여 표현을 다양하게 두면서 `top_p`를 $0.5\sim0.8$ 수준으로 낮추는 방식이다. 이렇게 조합하면 분포 끝의 엉뚱한 단어들이 잘려 나가 문장이 깨지지 않으면서 다채로운 답변을 얻을 수 있다.

### 4) Repetition Penalty와 Logit Bias: 개별 토큰 확률 조정

전체 분포 모양이 아니라 특정 토큰의 선택 확률을 직접 제어하는 파라미터도 있다.
- **Repetition Penalty (반복 페널티)**: 이미 생성한 답변에 등장한 단어 확률을 깎아 같은 구절 반복을 막는다(`1.2` 수준이 적당하다). 값을 `2.0` 이상으로 과도하게 높이면 문법상 자연스럽게 반복되어야 하는 관사(`the`, `a`)나 전치사(`in`, `of`)까지 쓰지 못해 문장이 망가진다.
- **Logit Bias (로짓 편향)**: 특정 토큰의 원시 확률(Logit)에 값을 더하거나 빼서 선택 확률을 직접 높이거나 낮춘다. 금칙어 토큰 확률을 낮춰 차단하거나, 분류기 작업에서 지정된 라벨 토큰만 출력하도록 유도할 때 유용하다.

### 5) 파라미터 딕셔너리 생성기 (`generate_params_dict`)

실습 환경에서는 단일 프롬프트 문자열을 받아 LLM을 호출하는 `generate_with_single_input`과 여러 대화 메시지 리스트를 받는 `generate_with_multiple_input`을 사용한다. 두 함수 모두 호출 시 `{'role': 'assistant', 'content': '생성된 답변 텍스트'}` 딕셔너리를 반환한다.

호출할 때마다 긴 파라미터를 괄호 안에 나열하면 코드가 복잡해지고 작업 성격에 따라 설정을 바꾸기 어렵다. 파이썬의 **`**kwargs` 딕셔너리 언패킹**을 활용하면 파라미터를 딕셔너리로 조립한 뒤 한 번에 전달할 수 있다. 먼저 직접 전달과 언패킹 전달을 비교한다.

```python
from utils import generate_with_single_input, generate_with_multiple_input

# [방식 1] 함수 괄호 안에 파라미터를 직접 나열하는 기본 호출
response_direct = generate_with_single_input(
    prompt="Solve x^2 - 1 = 0",
    role="user",
    temperature=0.3,
    top_p=0.7,
    max_tokens=500,
    model="meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo"
)

# [방식 2] 딕셔너리에 파라미터를 담은 뒤 **로 언패킹하여 전달 (방식 1과 동일하게 동작)
my_params = {
    "prompt": "Solve x^2 - 1 = 0",
    "role": "user",
    "temperature": 0.3,
    "top_p": 0.7,
    "max_tokens": 500,
    "model": "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo"
}
response_unpacked = generate_with_single_input(**my_params)

print(response_unpacked)
# 출력 예시: {'role': 'assistant', 'content': 'To solve the equation x^2 - 1 = 0, ...'}
```

매번 수동으로 딕셔너리를 작성하는 과정을 단순화하고 기본값을 지정해 주는 헬퍼 함수가 `generate_params_dict`다. 이후 7장 챗봇 파이프라인에서도 이 함수를 그대로 사용한다.

```python
def generate_params_dict(
    prompt: str, 
    temperature: float = None, 
    role: str = 'user',
    top_p: float = None,
    max_tokens: int = 500,
    model: str = "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo"
) -> dict:
    """LLM 호출 함수에 **kwargs로 언패킹하여 전달할 파라미터 딕셔너리를 생성한다."""
    kwargs = {
        "prompt": prompt,
        "role": role,
        "temperature": temperature,
        "top_p": top_p,
        "max_tokens": max_tokens,
        "model": model
    }
    return kwargs

# 사용 예시: 수식 풀이 프롬프트와 샘플링 파라미터 조립 후 **로 언패킹 호출
kwargs = generate_params_dict("Solve x^2 - 1 = 0", temperature=0.3, top_p=0.7)
response = generate_with_single_input(**kwargs)
print(response['content'])
```

> [!TIP]
> **`**kwargs` 사용 시 주의점**
> `generate_with_single_input(kwargs)`처럼 앞에 별표 두 개(`**`)를 빼고 호출하면, 파이썬은 딕셔너리 전체를 첫 번째 위치 인자인 `prompt`로 인식해 `TypeError`를 일으킨다. 딕셔너리의 키와 값 쌍을 키워드 인자로 풀어서 넘길 때는 반드시 `**kwargs`를 붙여야 한다.

---

## 3. 모델 선택과 벤치마크

RAG 애플리케이션에 사용할 LLM을 고를 때는 먼저 정량적 스펙으로 후보군을 좁힌 뒤, 벤치마크로 정성적 품질을 평가한다.

### 1) 5가지 정량적 비교 지표

1. **모델 크기(Model Size)**: 파라미터 수로 측정한다. 소형 모델(`1B~10B`)은 가볍고 저렴해 단순 분류와 라우팅에 적합하다. 대형 모델(`100B~500B` 이상)은 복잡한 추론 능력이 뛰어나지만 비용과 지연이 높다.
2. **비용(Cost)**: 일반적으로 100만 토큰당 단가로 과금되며, 입력 토큰과 출력 생성 토큰의 단가가 다르게 책정된다.
3. **컨텍스트 윈도우(Context Window)**: 입력과 출력을 합쳐 모델이 한 번에 처리할 수 있는 최대 토큰 수다. 윈도우가 크면 많은 문서를 넣을 수 있지만 처리량에 비례해 비용과 지연이 늘어난다.
4. **지연 시간과 생성 속도(Latency & Speed)**: 첫 토큰이 나오기까지 걸리는 **TTFT(Time To First Token)**와 초당 생성 토큰 수 **TPS(Tokens Per Second)**로 잰다. 대화형 시스템에서는 약간의 품질 차이를 감수하더라도 지연이 짧은 모델이 유리할 수 있다.
5. **지식 기준일(Knowledge Cutoff Date)**: 사전 학습 데이터에 포함된 마지막 시점이다. RAG로 외부 지식을 주입하더라도 최신 맥락을 이해하려면 기준일이 최신인 모델이 유리하다.

### 2) 모델 품질을 측정하는 3대 벤치마크 방식

| 벤치마크 분류 | 평가 방식 및 대표 사례 | 강점 및 주의점 |
|---|---|---|
| **자동화 벤치마크**<br>(Automated Benchmarks) | 객관식 시험이나 수학 및 코딩 문제처럼 정답 여부를 코드로 자동 채점 (대표: **MMLU**) | 채점이 빠르고 재현성이 높으나 개방형 문장 품질이나 뉘앙스는 측정하기 어려움 |
| **인간 평가 벤치마크**<br>(Human Scoring) | 익명 두 모델 응답 중 사람이 더 나은 답을 고르고 **Elo**로 순위 산출 (대표: **LLM Arena**) | 실제 체감 품질을 가장 잘 반영하나 평가 시간과 비용이 많이 듦 |
| **LLM-as-a-Judge**<br>(심판 LLM 평가) | 기준 정답을 가진 심판 LLM이 답변을 채점해 **승률(Win rate)** 계산 | 저렴하게 대규모 평가 가능하나 자기 계열 편향 보정이 필수적임 |

### 3) 좋은 벤치마크의 조건과 데이터 오염과 포화 현상

프로젝트 벤치마크를 고를 때는 네 가지 조건을 확인해야 한다. 우선 프로젝트 도메인과의 **관련성**, 상위와 하위 모델을 가리는 **충분한 난이도**, 반복 측정 시 점수가 유지되는 **재현성**, 그리고 실제 체감 성능과의 **일치성**이다.

벤치마크 점수를 해석할 때는 두 가지 왜곡 요인을 주의한다.
- **데이터 오염(Data Contamination)**: 벤치마크 문제와 정답이 인터넷 훈련 데이터에 이미 섞여 들어갔다면, 모델이 추론 능력이 아니라 암기한 답을 내놓아 점수가 과대평가된다.
- **벤치마크 포화(Benchmark Saturation)**: 기술이 빠르게 발전하면서 대부분 모델이 수년 만에 만점 근처에 도달해 더 이상 모델 간 성능 변별이 불가능해진다.

![시간 경과에 따른 LLM 벤치마크 포화 현상](/images/rag/module4/benchmark_saturation.png)

대부분의 최신 모델이 최고점에 몰려 변별력을 잃은 상태를 **포화(Saturated)**라고 부른다. 따라서 LLM 선택은 고정된 결정이 아니라 더 낫고 저렴한 모델이 나올 때마다 쉽게 교체할 수 있는 모듈형 구조로 설계해야 한다.

---

## 4. 프롬프트와 구조화 출력

### 1) `messages` 포맷과 멀티턴 대화 상태 유지 (`call_llm_with_context`)

코드로 LLM에 프롬프트를 전달할 때는 각 메시지가 `role`(역할)과 `content`(내용) 키를 갖는 딕셔너리 리스트(`messages`)를 표준으로 쓴다.
- **`system`**: LLM의 행동 지침, 어조, 준수 규칙을 설정한다.
- **`user`**: 사용자가 입력한 질문이나 요청을 기록한다.
- **`assistant`**: 이전에 LLM이 생성했던 응답을 기록한다.

이 JSON 리스트를 API로 전송하면 내부적으로 `<|begin_of_text|><|start_header_id|>system<|end_header_id|>...` 같은 특수 태그가 붙은 하나의 긴 문자열(Chat Template)로 변환되어 모델에 입력된다.

중요한 점은 **LLM 자체는 이전 대화를 기억하는 메모리 상태를 갖고 있지 않다**는 것이다. 따라서 멀티턴(Multi-turn) 챗봇을 구현하려면 대화 기록 리스트(`context`)에 새 질문과 모델 답변을 계속 `.append()`하며 매번 전체 대화 내역을 다시 전송해야 한다.

먼저 `generate_with_multiple_input`으로 두 번의 대화를 수동으로 이어가는 기본 흐름을 확인한다.

```python
# [기본 예제] 대화 리스트(messages)에 질문과 답변을 수동으로 .append()하며 멀티턴 유지하기
messages = [
    {"role": "system", "content": "You are a helpful assistant."}
]

# --- 1번째 턴 ---
messages.append({"role": "user", "content": "What is the capital of France?"})
reply_1 = generate_with_multiple_input(messages)  # {'role': 'assistant', 'content': 'The capital of France is Paris.'}
messages.append(reply_1)                          # LLM의 답변도 리스트에 추가해야 다음 턴에서 기억함

# --- 2번째 턴 ---
# 앞선 대화가 messages에 누적되어 있으므로 "there"가 파리를 뜻함을 파악함
messages.append({"role": "user", "content": "What is a famous landmark there?"})
reply_2 = generate_with_multiple_input(messages)
messages.append(reply_2)
```

매 턴 반복되는 3단계(`새 질문 추가 ➔ 다중 입력 호출 ➔ 답변 누적`)를 함수로 묶은 것이 `call_llm_with_context`다.

```python
def call_llm_with_context(prompt: str, context: list, role: str = 'user', **kwargs) -> dict:
    """
    기존 대화 내역 리스트(context)에 새 질문을 추가하여 LLM을 호출하고,
    반환된 응답까지 context에 누적하여 멀티턴 대화 맥락을 유지한다.
    """
    # 1. 새 프롬프트를 대화 내역 끝에 추가
    context.append({'role': role, 'content': prompt})

    # 2. 누적된 전체 대화 내역으로 응답 생성
    response = generate_with_multiple_input(context, **kwargs)

    # 3. LLM 답변도 다음 턴을 위해 내역 끝에 추가
    context.append(response)

    return response

# 멀티턴 대화 실행 예시
context = [
    {"role": "system", "content": "You are an ironic but helpful assistant."},
    {"role": "assistant", "content": "How can I help you, majesty?"}
]
first_turn = call_llm_with_context("Make a 2 sentence poem", role="user", context=context)
second_turn = call_llm_with_context("Now add two more sentences.", role="user", context=context)
print(second_turn['content'])
```

```text
The sun sets slow and paints the sky with fiery hue,
A final dance before the night's dark curtain falls on you.
Stars begin to twinkle, like diamonds in the velvety expanse,
Another day is done, as the world succumbs to a peaceful trance.
```

### 2) 시스템 프롬프트와 표준 RAG 프롬프트 템플릿

상용 챗봇의 시스템 프롬프트에는 모델의 지식 기준일과 현재 날짜, 어조, 출력 형식을 지정한다. RAG 시스템 프롬프트에는 여기에 더해 **"오직 검색된 문서에 있는 정보만 사용해 답할 것"**, **"문서 관련성을 판단할 것"**, **"답변 시 반드시 출처를 인용할 것"**을 명시한다.

멀티턴 RAG 시스템의 프롬프트 템플릿은 네 가지 요소를 순서대로 조립한다.

![표준 RAG 프롬프트 템플릿 구조](/images/rag/module4/prompt_template.png)

1. **`# System Instructions`**: 행동 수칙과 근거 기반 응답 규칙을 담은 시스템 프롬프트
2. **`# Conversation History`**: 이전 턴까지 주고받은 `User` 및 `Assistant` 대화 기록
3. **`# Retrieved Information`**: 검색기가 찾아온 상위 `5~10`개 문서 청크와 활용 지침
4. **`# User Question`**: 모델이 답변해야 할 가장 최근의 사용자 질문

### 3) 고급 프롬프트 기법과 추론 모델(Reasoning Models)의 특수성

기본 템플릿 위에 응답 품질을 높이는 기법들을 결합할 수 있다.
- **인컨텍스트 러닝(In-Context Learning)**: 프롬프트 안에 질문과 모범 답변 쌍을 넣어 출력 구조와 어조를 맞추게 한다(1개면 **One-shot**, 여러 개면 **Few-shot**). 과거 우수 문답을 벡터 DB에 인덱싱해 두고 유사한 과거 문답을 실시간 검색해 주입하는 **동적 Few-shot RAG**도 효과적이다.
- **Scratchpad와 Chain-of-Thought(CoT)**: 최종 답변을 내놓기 전에 `<scratchpad>...</scratchpad>` 공간에서 먼저 풀이를 정리하거나, 단계별(Step-by-step) 추론을 유도해 정확도를 높인다.
- **추론 전용 모델(Reasoning Models) 사용 시 주의점**: 최근 추론 모델은 별도 지시 없이도 내부적으로 **추론 토큰(Reasoning Tokens)**을 먼저 생성한 뒤 최종 응답을 출력한다. 다단계 논리 결합에 강점이 있지만, 눈에 보이지 않는 추론 토큰도 일반 토큰과 똑같이 비용과 시간을 소모한다.
  - 또한 일반 LLM에 쓰던 프롬프트 기법이 추론 모델에서는 역효과를 낼 수 있다. 이미 단계별 추론이 내재화되어 `"Think step by step"` 지시는 불필요하며, **Few-shot 예시를 넣으면 모델이 예시 답변 내용을 현재 질문의 사실 정보로 오인해 답변에 억지로 섞는 문제**가 생긴다. 따라서 추론 모델에는 명확한 목표와 출력 형식만 지정하고 검색 문서를 바로 전달하는 편이 낫다.

### 4) 컨텍스트 윈도우 관리와 문맥 가지치기(Context Pruning)

검색 문서, 예시, 추론 토큰, 멀티턴 대화가 누적되면 컨텍스트 윈도우가 빠르게 차면서 비용과 응답 지연이 커진다.

![일반 LLM과 추론 모델+RAG 결합 시의 컨텍스트 윈도우 점유 비교](/images/rag/module4/reasoning_context_window.png)

불필요한 문맥을 덜어내는 **문맥 가지치기(Context Pruning)** 전략 네 가지를 적용한다.
1. **단일 턴 검증**: CoT나 인컨텍스트 예시가 평가에서 성능 향상을 주지 못하면 프롬프트에서 제거한다.
2. **대화 내역 슬라이딩 및 요약**: 멀티턴 대화에서는 최근 $N$개(예: 최근 5개) 메시지만 유지하거나, 경량 LLM으로 오래된 대화를 짧게 요약해 보관한다.
3. **과거 추론 토큰 삭제**: 추론 모델 멀티턴 대화에서는 이전 턴의 추론 토큰을 버리고 최종 응답 토큰만 남긴다.
4. **최신 검색 청크만 유지**: 이전 질문을 답할 때 쓴 과거 검색 청크는 빼고, 가장 최근 질문에 대해 검색된 청크만 포함한다.

### 5) 후속 처리를 위한 구조화 출력(JSON) 강제 기법

LLM 출력을 다른 함수나 DB 필터로 넘기려면 자연어가 아닌 유효한 JSON 객체를 반환하도록 강제해야 한다. 상황에 따라 두 가지 템플릿 중 하나를 선택한다.

#### 방법 1: 프롬프트 기반 JSON 추출 템플릿 (f-string 이중 중괄호 `{{ }}`)
프롬프트 문자열 안에 허용 키와 목표 JSON 예시를 직접 적는 방식이다. 이때 **파이썬 f-string 안에서 JSON 중괄호를 표현하려면 반드시 이중 중괄호 `{{` `}}`로 감싸야 한다.** 단일 중괄호 `{변수명}`은 변수 치환 자리다. 반면 이중 중괄호 `{{` `}}`는 f-string이 평가된 뒤 문자열 안에 단일 `{`와 `}`로 남도록 이스케이프하는 문법이다.

```python
# [방법 1 템플릿] 프롬프트 지시문으로 JSON 출력을 유도할 때의 f-string 작성법
# - 단일 중괄호 {allowed_colors}, {user_query}: 파이썬 변수 값이 치환된다.
# - 이중 중괄호 {{ }}: 프롬프트 문자열 안에 실제 JSON 중괄호 '{', '}'로 출력된다.
user_query = "I need a blue shirt under 50 dollars."
allowed_colors = ["Blue", "Red", "Black"]

prompt = f"""Extract metadata from the user query and return ONLY a JSON object.
Allowed colors: {allowed_colors}

Example of expected JSON:
{{
  "color": "Blue",
  "max_price": 50
}}

Query: {user_query}"""
```

#### 방법 2: Pydantic `BaseModel`과 `response_format` 기반 스키마 강제
프롬프트 지시만으로는 LLM이 JSON 앞뒤에 `"Here is the JSON:"` 같은 사족을 붙이거나 쉼표를 빠뜨릴 수 있다. 이를 막으려면 **Pydantic `BaseModel`**로 출력 필드명, 타입, 설명을 선언한 뒤 API의 `response_format`에 넘긴다. 이렇게 하면 토큰 샘플링 단계에서 스키마에 어긋나는 토큰 생성이 차단되어 문법적으로 유효한 JSON만 나온다.

```python
from pydantic import BaseModel, Field
import json

# 1. 원하는 JSON 키 이름과 타입을 Pydantic BaseModel 클래스로 정의
class VoiceNote(BaseModel):
    title: str = Field(description="A title for the voice note")
    summary: str = Field(description="A short one sentence summary of the voice note.")
    actionItems: list[str] = Field(description="A list of action items from the voice note")

transcript = (
    "Good morning! It's 7:00 AM, and I'm just waking up. Today is going to be a busy day, "
    "so let's get started. First, I need to make a quick breakfast. I think I'll have some "
    "scrambled eggs and toast with a cup of coffee. While I'm cooking, I'll also check my "
    "emails to see if there's anything urgent."
)

messages = [
    {"role": "system", "content": "The following is a voice message transcript. Only answer in JSON."},
    {"role": "user", "content": transcript}
]

# 2. .model_json_schema()를 추출해 response_format에 지정
response_format = {
    "type": "json_schema",
    "schema": VoiceNote.model_json_schema(),
}

# 3. LLM 호출 후 json.loads()로 파이썬 딕셔너리 변환
result = generate_with_multiple_input(messages, response_format=response_format)
result_json = json.loads(result['content'])
print(json.dumps(result_json, indent=2))
```

```json
{
  "title": "Morning Routine and Tasks",
  "summary": "The speaker outlines their morning plans, including making breakfast and checking emails.",
  "actionItems": [
    "Make scrambled eggs, toast, and coffee for breakfast",
    "Check emails for urgent messages"
  ]
}
```

---

## 5. 환각 제어와 RAGAS

### 1) RAG 시스템에서 환각(Hallucination)이 발생하는 원인과 유형

RAG 파이프라인을 구축하더라도 환각은 완전히 사라지지 않는다. 예를 들어 쇼핑몰 챗봇에 고객이 `"학생 할인이 있나요?"`라고 물었을 때, 검색기가 할인 키워드 유사도로 **경로 우대 할인(10%)**과 **신규 고객 할인(10%)** 문서를 가져왔다고 가정하자. 여기에 `"고객에게 항상 친절하고 도움이 되게 답하라"`는 지침이 겹치면, LLM이 문서에 없는 학생 할인을 만들어내 `"학생증이 있으면 동일하게 10% 할인을 받을 수 있습니다"`라고 답하기 쉽다.

이는 LLM이 사실과 거짓을 구별하는 엔진이 아니라, 주어진 문맥 뒤에 이어질 **확률적으로 가장 그럴듯한 토큰 시퀀스를 생성**하기 때문에 생긴다. 환각은 세 가지 형태로 나타난다.
1. **세부 정보 왜곡**: 실제로 있는 경로 우대 할인을 설명하면서 할인율을 10% 대신 5%로 잘못 적는다.
2. **존재하는 사실 부정**: 경로 우대 할인이 문서에 있는데도 할인이 없다고 답한다.
3. **없는 사실 날조**: 문서 어디에도 없는 학생 할인을 새로 지어낸다.

### 2) 환각 탐지 기법과 ContextCite / ALCE

외부 지식베이스 없이 환각을 탐지하려면 같은 프롬프트로 여러 번 답변을 생성하게 한 뒤 사실 관계 일치를 확인하는 **자기 일관성 검사(Self-Consistency Checking)**를 쓸 수 있다. 환각 시 세부 수치가 달라지는 점을 이용한 방식이지만 LLM 호출 비용이 배로 든다.

반면 지식베이스가 있는 RAG 시스템에서는 `"검색 문서에 기반한 사실만 말하라"`고 제한하고, 각 문장 끝에 **출처를 인용(Cite sources)**하도록 지시하는 편이 효과적이다. 다만 LLM은 출처 표시도 지어낼 수 있으므로, 높은 신뢰도가 필요할 때는 **ContextCite** 같은 외부 검증기를 결합한다.

![ContextCite를 통한 문장별 검색 문서 출처 매핑](/images/rag/module4/context_cite.png)

- **ContextCite의 동작 원리**: 생성된 답변을 문장 단위로 분리한 뒤, 각 문장이 검색 컨텍스트 중 어느 문서에 근거하는지 사후 추적해 출처 태그와 점수를 매긴다. 근거가 없는 문장에는 **`No Source`** 태그를 붙여 환각 문장을 식별한다.
- **ALCE 벤치마크**: 환각 억제와 출처 인용 정확도를 평가하는 벤치마크다. 답변에 대해 **유창성(Fluency)**, **정확성(Correctness)**, **인용 품질(Citation Quality, 인용 출처와 실제 근거의 일치도)** 세 점수를 산출한다.

### 3) RAGAS 라이브러리를 활용한 LLM 생성 성능 평가

답변 품질이 낮을 때 검색기 문제인지 LLM 생성 문제인지 분리해야 엉뚱한 모듈을 고치는 낭비를 막을 수 있다. 검색기가 문서를 잘 찾아왔다는 전제 아래, 오픈소스 **RAGAS** 라이브러리는 평가용 LLM(LLM-as-a-Judge)으로 생성 품질을 정량화한다.

#### ① Response Relevancy (응답 관련성)
생성된 답변이 **사용자의 원래 질문 의도에 동문서답하지 않고 적절히 답했는지**를 측정한다.

![RAGAS Response Relevancy 계산 과정](/images/rag/module4/ragas_relevancy.png)

1. RAG 시스템의 최종 답변을 평가용 LLM에 넣고, **"이 답변이 나오려면 사용자가 어떤 질문을 했을지" 역추론한 샘플 질문 여러 개**를 만든다.
2. 원래 사용자 질문과 역생성된 샘플 질문들을 임베딩 모델로 벡터화한다.
3. 원래 질문 벡터와 샘플 질문 벡터 사이의 **코사인 유사도** 평균을 구한다. 답변만 보고도 원래 질문을 정확히 역추적할 수 있으면 질문 의도에 부합한 것으로 판단한다.

#### ② Faithfulness (충실도)
생성된 답변이 **검색된 문서 내용에 얼마나 충실하게 기반하는지(환각 없이 근거만 썼는지)**를 측정한다.

![RAGAS Faithfulness 계산 과정](/images/rag/module4/ragas_faithfulness.png)

1. 평가용 LLM을 호출해 답변 텍스트 안에 포함된 **모든 사실적 주장들을 개별 명제 단위로 추출**한다 (예: `"아인슈타인은 독일에서 태어났다"`, `"그는 1879년 3월 20일에 태어났다"`).
2. 추가 LLM 호출로 각 주장이 검색 문서로 뒷받침되는지 하나씩 대조한다.
3. **전체 주장 개수 대비 뒷받침되는 주장 비율(%)**을 Faithfulness 점수로 삼는다(위 그림에서는 2개 중 1개만 일치해 50%).

이 밖에도 UI에 좋아요/싫어요 피드백 버튼을 두고 검색기는 고정한 채 LLM이나 시스템 프롬프트만 바꾸며 **A/B 테스트**를 진행해 개선 효과를 측정할 수 있다.

---

## 6. 에이전트와 파인튜닝

### 1) 에이전트 RAG(Agentic RAG)와 4대 워크플로 패턴

단일 LLM에 모든 처리를 맡기는 대신 작업을 여러 단계와 의사결정으로 나누는 방식이 **에이전트 RAG**다. 단계마다 특화된 여러 LLM을 연결하고 외부 도구(벡터 DB, 코드 인터프리터, 웹 API 등)를 호출해 문제를 푼다.

![라우터와 평가자 LLM을 결합한 에이전트 RAG 시스템 구조](/images/rag/module4/agentic_rag_pipeline.png)

위 구조에서는 하나의 질문을 처리하기 위해 역할과 크기가 다른 여러 LLM이 분업한다.
1. **Router LLM (경량 모델)**: 질문이 벡터 DB 검색이 필요한지(`yes` / `no`) 먼저 가린다. 인사말처럼 검색이 불필요하면 DB 조회를 건너뛰어 비용과 시간을 아낀다.
2. **Evaluator LLM (경량 모델)**: 검색된 문서들이 답하기에 충분한지 평가하고, 부족하면 추가 검색을 요청한다.
3. **생성 LLM 및 Citation LLM**: 충분한 근거가 모이면 고성능 LLM이 초안을 작성하고, 인용 특화 LLM이 문장별 출처를 붙인다.

에이전트 RAG에서 자주 쓰는 네 가지 워크플로 패턴은 다음과 같다.

![에이전트 RAG의 4대 워크플로 패턴 비교](/images/rag/module4/agentic_workflows_4types.png)

- **순차적 워크플로(Sequential Workflow)**: `쿼리 파서 LLM ➔ 쿼리 재작성 LLM ➔ 답변 생성 LLM ➔ 인용 생성 LLM`처럼 출력을 다음 모델로 일직선 전달한다.
- **조건부 워크플로(Conditional Workflow)**: 라우터 LLM이 질문 성격을 분류해 여러 경로(예: FAQ DB vs 상품 DB) 중 하나로 분기한다.
- **반복적 워크플로(Iterative Workflow)**: 작성자 LLM 초안을 평가자 LLM이 검증하고, 기준을 통과할 때까지 피드백을 주어 루프(Loop)를 반복한다.
- **병렬 워크플로(Parallel Workflow)**: 지휘자 LLM이 복합 질문을 하위 작업으로 쪼개 여러 LLM에 동시 할당한 뒤 종합자 LLM이 결과를 합친다.

### 2) RAG vs 파인튜닝(Fine-Tuning)

**파인튜닝(Fine-Tuning)**은 프롬프트에 정보를 넣는 대신 도메인 특화 데이터셋(`질문` + `모범 정답`)을 준비한다. 이 데이터로 **모델 가중치 자체를 재학습(지도 미세조정, SFT / Instruction Tuning)**하는 방식이다. 의료 문답 데이터셋으로 튜닝한 모델은 의학 용어와 진단 형식에 맞춰 답한다. 다만 특정 도메인에 가중치를 맞추면 일반 작업 성능이 떨어질 수 있어, 라우팅 같은 단일 작업용 소형 모델에 적용할 때 특히 효과적이다.

![RAG와 파인튜닝의 핵심 목적 비교](/images/rag/module4/rag_vs_finetuning.png)

두 기법의 선택 기준은 명확하다.
- **RAG는 새로운 지식 주입에 적합**: 파인튜닝은 모델에 최신 사실을 외우게 하는 데 비효율적이므로, 수시로 바뀌는 외부 문서는 RAG로 참조해야 한다.
- **파인튜닝은 어조와 출력 형식 적응에 적합**: 응답 어조, 특정 JSON 스타일, 단일 분류 작업 특화가 목표일 때 파인튜닝을 사용한다.
- **상호보완적 결합**: 에이전트 파이프라인의 라우터에 파인튜닝된 경량 모델을 두고, 생성 LLM은 검색 문서를 정확히 인용하고 관련 없는 문서를 무시하도록 파인튜닝해 함께 쓸 수 있다.

---

## 7. 라우팅 RAG 챗봇 구현

지금까지 다룬 기법을 하나로 묶어 의류 쇼핑몰(`Fashion Forward Hub`) 에이전트 챗봇을 구현한다. **에이전트 조건부 라우팅**, **작업 성격별 동적 샘플링 제어**, **LLM 기반 메타데이터 JSON 추출**, **Weaviate 벡터 DB 필터링**을 순서대로 결합한다.

세부 코드를 작성하기 전에, 사용자 질문이 들어와 최종 LLM 호출 파라미터 딕셔너리(`kwargs`)로 조립되기까지 전체 분기 흐름을 요약한다.

| 처리 단계 | 실행 동작 | 다음 분기 |
|---|---|---|
| **1차 의도 분류** | 질문이 매장 정책(`FAQ`)인지 상품 문의(`Product`)인지 판별 | 분류 불가 시 폴백 안내 프롬프트 반환 |
| **FAQ 경로** | FAQ 25개 문답 전체를 `<FAQ>` 태그로 묶어 프롬프트 조립 | 기본 샘플링 설정으로 최종 답변 생성 |
| **상품 경로 (2차 분류)** | 상품 질문이 사실 조회(`technical`)인지 코디 추천(`creative`)인지 분류 | 성격에 맞는 `temperature`, `top_p` 결정 |
| **상품 경로 (검색과 조립)** | 질문에서 메타데이터 JSON 필터 추출 후 Weaviate 검색(결과 부족 시 완화) | 검색 상품 컨텍스트와 샘플링 파라미터 결합 |

각 하위 파이프라인은 LLM을 직접 호출해 끝내지 않고, 최종 생성 단계(`generate_with_single_input(**kwargs)`)에 넘길 파라미터 딕셔너리를 반환하는 구조로 통일한다.

### 1) 데이터셋과 Weaviate 컬렉션 준비

쇼핑몰에는 의류 상품 정보를 담은 `PRODUCTS_DATA`와 매장 이용 문답을 담은 `FAQ` 두 가지 데이터가 있다. 로컬 Weaviate 연결(`client`)과 함께 두 데이터셋, 그리고 상품 컬렉션 참조(`products_collection`)를 먼저 불러온다. *(파라미터 조립은 앞선 2장에서 작성한 `generate_params_dict`를 그대로 사용한다.)*

```python
import json
import joblib
import weaviate
from weaviate.classes.query import Filter
from utils import generate_with_single_input

# 로컬 Weaviate 서버 연결 및 데이터셋, 컬렉션 로드
client = weaviate.connect_to_local(port=8079, grpc_port=50050)
products_collection = client.collections.get('products')
PRODUCTS_DATA = joblib.load('dataset/clothes_json.joblib')
FAQ = joblib.load('dataset/faq.joblib')

print("상품 샘플:", PRODUCTS_DATA[0])
print("FAQ 샘플:", FAQ[0])
```

```text
상품 샘플: {
  'gender': 'Men',
  'masterCategory': 'Apparel',
  'subCategory': 'Topwear',
  'articleType': 'Shirts',
  'baseColour': 'Navy Blue',
  'season': 'Fall',
  'year': 2011,
  'usage': 'Casual',
  'productDisplayName': 'Turtle Check Men Navy Blue Shirt',
  'price': 67,
  'product_id': 15970
}
FAQ 샘플: {
  'question': 'What are your working hours?',
  'answer': 'Our customer support is available from 9 AM to 6 PM, Monday to Friday.',
  'type': 'general information'
}
```

- `PRODUCTS_DATA`는 성별(`gender`), 대분류(`masterCategory`), 상세 품목(`articleType`), 색상(`baseColour`), 계절(`season`), 용도(`usage`), 가격(`price`), 상품 번호(`product_id`) 등 11개 속성을 가진 의류 목록이며 Weaviate의 `'products'` 컬렉션에 적재되어 있다.
- `FAQ`는 반품, 교환, 영업시간 등 25개 문답으로 이루어진 리스트다.

### 2) FAQ와 상품 질문 1차 라우팅

질문이 들어오면 먼저 매장 정책 문의(`FAQ`)인지 구체적인 의류 검색 및 코디 요청(`Product`)인지 판별하는 조건부 라우팅을 거친다.

LLM을 분류기(라우터)로 쓸 때는 어떤 도메인에서든 아래 4단계 기본 구조를 재사용할 수 있다.

```python
# [LLM 라우터 기본 구조] 새로운 분류기를 만들 때 라벨과 예시만 교체해 사용한다
def route_query_template(query: str) -> str | None:
    prompt = f"""
    # 1. 분류할 라벨 종류와 판단 기준 정의
    Label the following query as 'LABEL_A' or 'LABEL_B'.
    - LABEL_A: (LABEL_A에 해당하는 질문 기준)
    - LABEL_B: (LABEL_B에 해당하는 질문 기준)

    # 2. 헷갈리기 쉬운 경계 사례를 포함한 Few-shot 예시 제공
    Examples:
    (예시 질문 1) Label: LABEL_A
    (예시 질문 2) Label: LABEL_B

    # 3. 사족 없이 라벨 단어 하나만 출력하도록 강제 + {query} 주입
    Return only one of the two labels: LABEL_A or LABEL_B.
    Instruction: {query}"""

    # 4. 항상 같은 단일 토큰 분류를 얻기 위해 temperature=0, max_tokens=1 설정 및 예외 방어
    kwargs = generate_params_dict(prompt, temperature=0, max_tokens=1)
    label = generate_with_single_input(**kwargs)['content'].strip()
    return label if label in ['LABEL_A', 'LABEL_B'] else None
```

이 구조를 바탕으로 1차 라우터 `check_if_faq_or_product`를 구현한다. 예시 중 네 번째 문장(`"I bought a T-shirt and I didn't like it. How can I get a refund? Label: FAQ"`)이 경계 기준 역할을 한다. 질문 안에 `"T-shirt"` 단어가 들어 있어도 핵심 의도가 환불 절차 문의이므로 `Product`가 아니라 `FAQ`로 분류하도록 가르친다.

```python
def check_if_faq_or_product(query: str) -> str:
    """사용자 질문을 분석하여 'FAQ', 'Product', 또는 분류 불가 시 None을 반환하는 1차 라우터."""
    prompt = f"""Label the following instruction as an FAQ-related query or a product-related query.
Product-related answers are specific to product information or require using product details to answer. Products are clothes from a store.
An FAQ question addresses common inquiries and provides answers to help users find the information they need.
Examples:
        Is there a refund for incorrectly bought clothes? Label: FAQ
        Tell me about the cheapest T-shirts that you have. Label: Product
        Do you have blue T-shirts under 100 dollars? Label: Product
        I bought a T-shirt and I didn't like it. How can I get a refund? Label: FAQ
        How can I contact the user support? Label: FAQ
        Create a look suitable for a wedding party happening during dawn. Label: Product

Return only one of the two labels: FAQ or Product.
Instruction: {query}"""

    # 일관된 단일 토큰 분류를 위해 temperature=0, max_tokens=1 설정
    kwargs = generate_params_dict(prompt, temperature=0, max_tokens=1)
    response = generate_with_single_input(**kwargs)
    label = response['content'].strip()

    if label not in ['FAQ', 'Product']:
        return None
    return label

# 5개 샘플 질문 라우팅 검증
test_queries = [
    'What is your return policy?',
    'Give me three examples of blue T-shirts you have available.',
    'How can I contact the user support?',
    'Do you have blue Dresses?',
    'Create a look suitable for a wedding party happening during dawn.'
]
for q in test_queries:
    print(f"Query: {q} -> Label: {check_if_faq_or_product(q)}")
```

```text
Query: What is your return policy? -> Label: FAQ
Query: Give me three examples of blue T-shirts you have available. -> Label: Product
Query: How can I contact the user support? -> Label: FAQ
Query: Do you have blue Dresses? -> Label: Product
Query: Create a look suitable for a wedding party happening during dawn. -> Label: Product
```

### 3) FAQ 전체 문맥 프롬프트 조립

1차 라우터가 `'FAQ'`로 분류한 질문은 전체 FAQ가 25개뿐이므로 벡터 DB 검색을 거치지 않는다. 25개 문답 전체를 하나의 문자열(`FAQ_LAYOUT`)로 이어 붙여 프롬프트에 그대로 주입한다.

외부 참조 텍스트를 프롬프트에 넣을 때는 모델이 어디서 어디까지가 참조 자료이고 어디가 실제 질문인지 혼동하지 않도록 `<FAQ>...</FAQ>` 같은 **구분자 태그(Delimiter Tag)**로 감싼다.

```python
# [컨텍스트 주입 프롬프트 기본 구조]
prompt_template = f"""(1. 행동 지침: 아래 제공된 자료만 참고해 답하고, 자료의 존재를 직접 언급하지 마라)
<CONTEXT>
{context_text}   # <-- (2. 참조할 문서 텍스트 주입)
</CONTEXT>
Question: {query}"""  # <-- (3. 마지막에 반드시 실제 사용자 질문 {query}를 추가)
```

이 구조를 적용해 `generate_faq_layout`과 `query_on_faq`를 작성한다. `query_on_faq` 역시 최종 LLM 실행기가 일괄 호출할 수 있도록 완성된 프롬프트와 추가 설정이 담긴 파라미터 딕셔너리를 반환한다.

```python
def generate_faq_layout(faq_dict: list) -> str:
    """FAQ 딕셔너리 리스트를 프롬프트 주입용 단일 문자열로 변환한다."""
    t = ""
    for f in faq_dict:
        t += f"Question: {f['question']} Answer: {f['answer']} Type: {f['type']}\n"
    return t

FAQ_LAYOUT = generate_faq_layout(FAQ)

def query_on_faq(query: str, **kwargs) -> dict:
    """FAQ_LAYOUT과 사용자 질문(query)을 결합한 프롬프트 파라미터 딕셔너리를 생성한다."""
    prompt = f"""You will be provided with an FAQ for a cloth store.
Answer the instruction based on it. You might use more than one question and answer to make your answer. Only answer the question and do not mention that you have access to a FAQ.
<FAQ>
PROVIDED FAQ: {FAQ_LAYOUT}
</FAQ>
Question: {query}"""

    # 외부에서 전달받은 추가 키워드 인자(**kwargs)를 그대로 generate_params_dict에 전달
    kwargs = generate_params_dict(prompt, **kwargs)
    return kwargs

# 반품 관련 복합 질문 실행 (반품 기간 FAQ + 반품 배송비 FAQ 동시 참조)
faq_kwargs = query_on_faq("I got my cloth but I didn't like it. How can I return it?")
faq_res = generate_with_single_input(**faq_kwargs)
print(faq_res['content'])
```

```text
To return a garment you didn't like, you can initiate the return process within 30 days of receiving your order. Follow these steps:

1. Ensure the item is unworn, unwashed, and in its original condition with all tags attached.
2. Contact our customer support or visit our Returns Center on our website to obtain a prepaid return shipping label (for domestic orders).
3. Pack the item securely and attach the prepaid return label to the package.
4. Drop off the package at the designated shipping carrier.

Once we receive and inspect the returned item, your refund will be processed within 5-7 business days.
```

> [!WARNING]
> **증강 프롬프트 작성 시 자주 빠지는 2가지 함정**
> 1. **`{query}` 누락**: `<FAQ>{FAQ_LAYOUT}</FAQ>`까지만 적고 마지막 줄에 `Question: {query}`를 빠뜨리면, LLM은 질문 내용을 알 수 없어 첫 번째 FAQ 항목만 임의로 요약해 버린다.
> 2. **`**kwargs` 전달 누락**: `def query_on_faq(query: str, **kwargs)`로 인자를 받아놓고 내부에서 `generate_params_dict(prompt)`만 호출하면, 호출자가 넘긴 `temperature`나 `model` 설정이 무시된다. 반드시 `generate_params_dict(prompt, **kwargs)`로 전달해야 한다.

### 4) 작업 성격 분류와 샘플링 파라미터 매핑

1차 라우터가 `'Product'`로 분류한 질문은 다시 두 성격으로 나뉜다.
- **`technical` (사실 조회)**: `"파란색 드레스 있나요?"`, `"가장 비싼 옷이 무엇인가요?"`처럼 카탈로그 사실과 가격을 묻는 질문이다. 환각을 줄이기 위해 **낮은 무작위성(`temperature: 0.3`, `top_p: 0.7`)**을 적용한다.
- **`creative` (코디 추천)**: `"화창한 날 공원 산책에 어울리는 코디를 짜줘"`처럼 여러 아이템을 조합하는 질문이다. 다채로운 제안을 위해 **높은 무작위성(`temperature: 1.0`, `top_p: 0.9`)**을 적용한다.

`get_params_for_task(task)` 함수가 바로 `generate_params_dict`를 부르지 않고 `{"top_p": ..., "temperature": ...}`만 먼저 반환하는 이유는 호출 순서 때문이다. 먼저 질문 성격으로 샘플링 수치 두 개만 결정해 두고, 이후 Weaviate 상품 검색을 마쳐 프롬프트가 완성된 뒤에 `generate_params_dict(prompt, **parameters_dict)`로 합친다.

```python
# [예제] 작업별 샘플링 설정 딕셔너리를 먼저 뽑고, 나중에 완성된 프롬프트와 합치는 흐름
# 1단계: 아직 검색 전이므로 prompt 없이 샘플링 파라미터 2개만 담긴 딕셔너리를 얻음
sampling_only = {"top_p": 0.7, "temperature": 0.3}

# 2단계: 검색이 끝나고 최종 prompt가 완성되면 **sampling_only로 언패킹하여 합침
final_prompt = "CLOTH PRODUCTS AVAILABLE: ... QUERY: Show me blue dresses"
full_kwargs = generate_params_dict(final_prompt, role="assistant", **sampling_only)
# 결과: {'prompt': '...', 'role': 'assistant', 'temperature': 0.3, 'top_p': 0.7, 'max_tokens': 500, ...}
```

이 설계에 맞춰 2차 라우터 `decide_task_nature`와 샘플링 파라미터 매핑 함수 `get_params_for_task`를 구현한다. `top_p`는 누적 확률 임계치이므로 반드시 $0 < \text{top\_p} \le 1.0$ 범위를 지켜야 하며, `1.0`을 넘기면 API 오류가 난다.

```python
def decide_task_nature(query: str) -> str:
    """상품 관련 질문이 'creative'(코디 추천)인지 'technical'(단순 상품과 가격 조회)인지 분류한다."""
    prompt = f"""Decide if the following query is a query that requires creativity (creating, composing, making new things) or technical (information about products, prices, etc.). Label it as creative or technical.
Examples:
Give me suggestions on a nice look for a nightclub. Label: creative
What are the blue dresses you have available? Label: technical
Give me three T-shirts for summer. Label: technical
Give me a look for attending a wedding party. Label: creative
I have a green dress and I like a suggestion on an accessory to match with it. Label: creative

Query to be analyzed: {query}. Only output one token: the label."""

    kwargs = generate_params_dict(prompt, temperature=0, max_tokens=1)
    response = generate_with_single_input(**kwargs)
    label = response['content'].strip().lower()
    return label

def get_params_for_task(task: str) -> dict:
    """작업 성격('technical' 또는 'creative')에 맞는 top_p와 temperature 딕셔너리를 반환한다."""
    PARAMETERS_DICT = {
        "creative": {"top_p": 0.9, "temperature": 1.0},
        "technical": {"top_p": 0.7, "temperature": 0.3}
    }

    if task == 'technical':
        param_dict = PARAMETERS_DICT['technical']
    elif task == 'creative':
        param_dict = PARAMETERS_DICT['creative']
    else:
        # 예상치 못한 라벨이 반환되면 중간값으로 폴백
        param_dict = {"top_p": 0.5, "temperature": 0.5}

    return param_dict
```

### 5) 자연어 질문에서 메타데이터 필터 JSON 추출

수천 개 의류 중 질문 조건에 맞는 상품을 찾으려면 시맨틱 검색 전에 메타데이터 필터로 후보를 좁혀야 한다. LLM에게 `"카테고리를 뽑아줘"`라고만 시키면 DB에는 `'Navy Blue'`로 저장돼 있는데 `'Dark Blue'`라고 적어내 검색 결과 0건이 나오는 **값 불일치(Value Mismatch)**가 생긴다.

따라서 데이터셋을 순회해 각 속성의 실제 고유값 집합(`set`)을 `values` 딕셔너리로 모은 뒤 프롬프트에 함께 넣어준다. 이때 고유값이 지나치게 많아 프롬프트를 부풀리는 5개 속성(`product_id`, `price`, `productDisplayName`, `subCategory`, `year`)은 뺀다. 대신 **6개 핵심 범주(`gender`, `masterCategory`, `articleType`, `baseColour`, `season`, `usage`)**의 허용 목록과 가격 범위(`price: {"min": ..., "max": ...}`)만 JSON으로 추출하게 한다.

```python
# 1. 6개 핵심 범주별 허용 가능한 고유값 집합(set) 추출
values = {}
for d in PRODUCTS_DATA:
    for key, val in d.items():
        if key in ('product_id', 'price', 'productDisplayName', 'subCategory', 'year'):
            continue
        if key not in values:
            values[key] = set()
        values[key].add(val)

print("gender 허용 값:", values['gender'])
print("season 허용 값:", values['season'])
# 출력 예시:
# gender 허용 값: {'Women', 'Men', 'Boys', 'Girls', 'Unisex'}
# season 허용 값: {'Summer', 'Winter', 'Fall', 'Spring', 'All seasons'}

# 2. 허용 값 목록(values)과 이중 중괄호({{ }}) 예시를 결합한 메타데이터 JSON 생성 함수
def generate_metadata_from_query(query: str) -> str:
    """자연어 질문에서 Weaviate 검색 필터링에 사용할 7개 키 구조의 메타데이터 JSON 문자열을 추출한다."""
    prompt = f"""A query will be provided. Based on this query, a vector database will be searched to find relevant clothing items.
Generate a JSON object containing useful metadata to filter products for this query.
The possible values for each feature are given in the following JSON: {values}

Provide a JSON containing the features that best match the query (values should be in lists, multiple values possible).
If a price range is mentioned, include a price key specifying the range (between values, greater than, or less than).
Return only the JSON, nothing else. The price key must be a JSON object with "min" and "max" values (use 0 if no lower bound, and "inf" if no upper bound).
Always include the following keys: gender, masterCategory, articleType, baseColour, price, usage, and season.
If no price is specified, set min = 0 and max = inf.
Include only values present in the JSON above.

Example of expected JSON:
{{
  "gender": ["Women"],
  "masterCategory": ["Apparel"],
  "articleType": ["Dresses"],
  "baseColour": ["Blue"],
  "price": {{"min": 0, "max": "inf"}},
  "usage": ["Formal"],
  "season": ["All seasons"]
}}

Query: {query}"""

    response = generate_with_single_input(prompt, temperature=0, max_tokens=1500)
    content = response['content']
    return content

sample_meta = generate_metadata_from_query(
    "Create a look for a man that suits a sunny day in the park. I don't want to spend more than 300 dollars on each piece."
)
print(sample_meta)
```

```json
{
    "gender": ["Men"],
    "masterCategory": ["Apparel"],
    "articleType": ["Tshirts", "Shorts", "Sunglasses"],
    "baseColour": ["Yellow", "Orange", "White", "Blue"],
    "price": {"min": 0, "max": 300},
    "usage": ["Casual"],
    "season": ["Summer"]
}
```

### 6) JSON 파싱 방어와 Weaviate 동적 필터 완화

이제 위 JSON을 Weaviate v4 `Filter` 객체 리스트로 바꾼다. 먼저 개별 속성 필터(`.contains_any`, `.greater_than`, `.less_than`)와 `.target` 속성, `Filter.all_of` 결합 문법을 확인한다.

```python
# 1. 범주형 속성 필터: 리스트 안의 값 중 하나라도 일치하면 통과 (.contains_any)
color_filter = Filter.by_property("baseColour").contains_any(["Blue", "White"])

# 2. 수치형 속성 필터: 초과(.greater_than) 및 미만(.less_than) 조건
min_price_filter = Filter.by_property("price").greater_than(0)
max_price_filter = Filter.by_property("price").less_than(300)

# 3. Filter 객체가 가리키는 속성 이름 확인 (.target)
print(color_filter.target)      # 출력: 'baseColour'
print(max_price_filter.target)  # 출력: 'price'

# 4. 여러 필터를 AND 조건(Filter.all_of)으로 결합해 검색
my_filters = [color_filter, min_price_filter, max_price_filter]
results = products_collection.query.near_text(
    query="summer shirt",
    filters=Filter.all_of(my_filters),
    limit=5
).objects
```

실제 파이프라인에서는 세 가지 예외 상황을 함께 방어해야 한다.
1. **비정형 JSON 문법 오류 방어 (`parse_json_output`)**: LLM 출력에 줄바꿈(`\n`)이나 이중 중괄호가 남아 있으면 정제한 뒤 `json.loads()`를 실행한다. 그래도 파싱할 수 없으면 에러로 중단하지 않고 `None`을 반환해 일반 시맨틱 검색으로 넘긴다.
2. **가격 하한과 상한 독립 검사 (`get_filter_by_metadata`)**: `"300달러 이하"` 질문의 JSON은 `{"min": 0, "max": 300}` 형태가 된다. 만약 `min <= 0 or max == 'inf'`처럼 OR 조건으로 건너뛰면 `min == 0` 때문에 **`max < 300` 상한 조건까지 통째로 빠지는 버그**가 생긴다. 따라서 하한(`min > 0`)과 상한(`max != 'inf'`)은 반드시 각각 독립 검사해 필터를 추가한다.
3. **과도한 AND 필터의 단계적 완화**: 7개 조건을 한꺼번에 만족하는 상품이 10개 미만이면 중요도가 낮은 속성(`gender` ➔ `season` ➔ `usage` ➔ `articleType` ➔ `masterCategory` ➔ `baseColour`) 순서대로 하나씩 제외하며 `5`개 이상의 후보가 확보될 때까지 단계적으로 조건을 넓힌다. 끝까지 못 채우면 필터 없이 시맨틱 검색으로 폴백한다.

```python
def parse_json_output(llm_output: str) -> dict | None:
    """LLM 출력 문자열에서 포맷 노이즈를 제거하고 JSON 딕셔너리로 파싱한다. 실패 시 None 반환."""
    try:
        cleaned = (
            llm_output.replace("\n", "")
            .replace("'", '"')
            .replace("}}", "}")
            .replace("{{", "{")
        )
        return json.loads(cleaned)
    except json.JSONDecodeError as e:
        print(f"JSON parsing failed: {e}")
        return None

def get_filter_by_metadata(json_output: dict | None = None) -> list | None:
    """파싱된 메타데이터 딕셔너리를 Weaviate Filter 객체 리스트로 변환한다."""
    if json_output is None:
        return None

    valid_keys = ('gender', 'masterCategory', 'articleType', 'baseColour', 'price', 'usage', 'season')
    filters = []

    for key, value in json_output.items():
        if key not in valid_keys:
            continue

        if key == 'price':
            if not isinstance(value, dict):
                continue
            min_price = value.get('min')
            max_price = value.get('max')
            # 하한(min > 0)과 상한(max != 'inf')을 독립 검사해야 {"min": 0, "max": 300}에서 max 필터가 누락되지 않는다
            if isinstance(min_price, (int, float)) and min_price > 0:
                filters.append(Filter.by_property(key).greater_than(min_price))
            if isinstance(max_price, (int, float)):
                filters.append(Filter.by_property(key).less_than(max_price))
        elif isinstance(value, list) and value:
            # 리스트 내 값 중 하나라도 일치하면 통과하는 contains_any 필터 추가
            filters.append(Filter.by_property(key).contains_any(value))

    return filters

def generate_filters_from_query(query: str) -> list | None:
    json_string = generate_metadata_from_query(query)
    json_output = parse_json_output(json_string)
    return get_filter_by_metadata(json_output)

def get_relevant_products_from_query(query: str) -> list:
    """
    메타데이터 필터와 시맨틱 검색을 결합하여 상품을 검색하되,
    결과가 10개 미만이면 덜 중요한 필터부터 차례대로 제거하며 최소 5개 이상을 확보한다.
    """
    filters = generate_filters_from_query(query)

    if not filters:
        return products_collection.query.near_text(query, limit=20).objects

    # 1차 검색: 모든 메타데이터 필터를 적용해 상위 20개 검색
    res = products_collection.query.near_text(query, filters=Filter.all_of(filters), limit=20).objects

    # 결과가 10개 미만이면 중요도가 낮은 속성부터 하나씩 제외하며 단계적으로 완화
    drop_order = ['gender', 'season', 'usage', 'articleType', 'masterCategory', 'baseColour']

    if len(res) < 10:
        for i in range(len(drop_order)):
            dropped = set(drop_order[:i + 1])
            relaxed = [x for x in filters if x.target not in dropped]
            if not relaxed:
                break
            res = products_collection.query.near_text(
                query, filters=Filter.all_of(relaxed), limit=20
            ).objects
            if len(res) >= 5:
                return res
        # 모든 완화 단계를 거쳐도 5개 미만이면 순수 시맨틱 검색으로 폴백
        if len(res) < 5:
            res = products_collection.query.near_text(query, limit=20).objects

    return res
```

### 7) 상품 컨텍스트 조립과 최종 오케스트레이터

Weaviate `.query.near_text(...).objects`가 반환하는 각 원소는 `.properties` 딕셔너리에 상품 속성(`product_id`, `productDisplayName` 등)을 담고 있다. 이제 상품 정보를 문자열로 묶는 `generate_items_context`, 상품 검색과 프롬프트를 연결하는 `query_on_products`, 그리고 전체 라우팅과 폴백을 제어하는 `answer_query`를 완성한다.

`answer_query`는 최종 문자열을 바로 출력하는 대신, 마지막 실행기(`generate_with_single_input(**kwargs)`)에 넘길 **파라미터 딕셔너리(`{"role": ..., "prompt": ...}`)**를 반환하는 점이 특징이다.
- **상품 경로에만 `try...except` 예외 처리를 두는 이유**: FAQ 경로는 이미 메모리에 로드된 정적 리스트(`FAQ_LAYOUT`)만 읽으므로 실패할 여지가 작다. 반면 상품 경로는 LLM JSON 생성, 파싱, Weaviate 필터 검색까지 외부 의존 단계가 많아 오류 가능성이 있으므로 예외 시 안전하게 재질문을 유도하는 폴백 프롬프트를 돌려준다.
- **매개변수 `role` 전달 방식**: `query_on_faq`는 기본값(`role='user'`)을 쓰고 `query_on_products`는 `role='assistant'`를 넘기지만, 둘 다 실습용 `generate_with_single_input` 호출 규약에 따라 최종 프롬프트 전달 대상을 지정하는 설정값으로 동작한다.

```python
def generate_items_context(results: list) -> str:
    """검색된 Weaviate 상품 객체 리스트를 프롬프트 주입용 텍스트 문자열로 포맷팅한다."""
    t = ""
    for item in results:
        props = item.properties
        t += (
            f"Product ID: {props['product_id']}. "
            f"Product name: {props['productDisplayName']}. "
            f"Product Category: {props['masterCategory']}. "
            f"Product SubCategory: {props['subCategory']}. "
            f"Product usage: {props['usage']}. "
            f"Product gender: {props['gender']}. "
            f"Product Type: {props['articleType']}. "
            f"Product Color: {props['baseColour']}. "
            f"Product Season: {props['season']}. "
            f"Product Year: {props['year']}.\n"
        )
    return t

def query_on_products(query: str) -> dict:
    """상품 질문의 성격을 판별해 샘플링 파라미터를 설정하고, 필터 검색 결과로 증강 프롬프트를 조립한다."""
    query_label = decide_task_nature(query)
    parameters_dict = get_params_for_task(query_label)

    relevant_products = get_relevant_products_from_query(query)
    context = generate_items_context(relevant_products)

    prompt = (
        f"Given the available set of cloth products, answer the question that follows, providing the item ID in your answers. "
        f"Other information might be provided but not necessarily all of them; pick only the relevant ones for the given query and avoid being too long when describing the items' features. "
        f"If no number of products is mentioned in the query, select at most five to show. "
        f"CLOTH PRODUCTS AVAILABLE: {context} "
        f"QUERY: {query}"
    )

    kwargs = generate_params_dict(prompt, role='assistant', **parameters_dict)
    return kwargs

def answer_query(query: str) -> dict:
    """사용자 질문을 받아 FAQ 또는 Product 워크플로로 라우팅하고 예외를 방어하는 최종 오케스트레이터."""
    label = check_if_faq_or_product(query)

    if label not in ['FAQ', 'Product']:
        return {
            "role": "assistant",
            "prompt": (
                f"User provided a question that does not fit FAQ or Product related questions. "
                f"Answer it based on the context you already have so far. Query provided by the user: {query}"
            )
        }
    if label == 'FAQ':
        kwargs = query_on_faq(query)
    if label == 'Product':
        try:
            kwargs = query_on_products(query)
        except Exception:
            return {
                "role": "assistant",
                "prompt": (
                    f"User provided a question that broke the querying system. Instruct them to rephrase it. "
                    f"Answer it based on the context you already have so far. Query provided by the user: {query}"
                )
            }

    return kwargs

# 최종 파이프라인 실행 검증
product_kwargs = answer_query("Give me three T-shirts for sunny days")
product_result = generate_with_single_input(**product_kwargs)
print(product_result['content'])
```

```text
Here are three T-shirts suitable for sunny days from our available products:

1. **Inkfruit Mens Little Bit More T-shirt** (Product ID: 1855)
   - **Color:** Yellow
   - **Usage:** Casual
   - **Season:** Summer

2. **Puma Men Pack of 3 Printed White T-shirt** (Product ID: 53759)
   - **Color:** White
   - **Usage:** Casual
   - **Season:** Summer

3. **ADIDAS Men Sprt Logo White T-shirt** (Product ID: 34039)
   - **Color:** White
   - **Usage:** Sports / Casual
   - **Season:** Summer
```

질문 의도를 분류하는 라우터 LLM과 작업 성격별 샘플링 제어를 결합하면 응답 유연성이 높아진다. 여기에 구조화된 JSON 필터 추출과 단계적 완화 폴백을 더하면 단일 검색-생성 구조보다 정교한 에이전트 RAG 시스템을 구축할 수 있다.

---

## 8. 참고 자료

1. **DeepLearning.AI** — *Retrieval Augmented Generation (RAG)*, Module 4: "LLM Generation, Prompt Engineering, Hallucinations, and Agentic RAG"
2. **Vaswani et al.** — *Attention Is All You Need* (Transformer Architecture, 2017)
