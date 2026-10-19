---
title: "Pydantic v2 데이터 검증 파이프라인과 도메인 타입 설계"
description: "정제되지 않은 원시 데이터 유입과 파싱 중단을 방어하기 위한 Pydantic v2 필드 검증기(before/after/wrap)의 내부 동작 메커니즘, handler 인터셉터 패턴, Annotated 기반 값 객체(VO) 재사용 패턴을 정리한다."
pubDate: "2026-10-19 13:30:00"
tags: ["Pydantic", "FastAPI", "Python", "DataValidation", "Backend"]
categories: ["Backend"]
draft: false
---

## 1. 타입 변환 기준점과 검증 시점

외부 결제 게이트웨이(PG사), 웹 프론트엔드 입력 폼, 또는 온톨로지 정보 추출 파이프라인(`ontology-map-workspace`)을 연동할 때 서버로 유입되는 원시 데이터는 완벽하게 정제된 상태가 아니다. 금액 필드에 `" 150,000 "`처럼 불필요한 공백과 쉼표(`,`)가 섞여 있거나, 신뢰도 점수 필드에 `" 95% "`처럼 단위 기호가 포함된 문자열이 빈번하게 전달된다.

Pydantic 모델에서 해당 필드를 정수형(`amount: int`)으로 선언해 두면, Pydantic 내부 파서는 들어온 원시 문자열에 대해 파이썬의 `int()` 변환을 시도한다. 그러나 문자열에 포함된 쉼표나 퍼센트 기호로 인해 변환 단계에서 즉시 `int_parsing` 에러(`ValidationError`)가 발생하며 요청 처리 전체가 중단된다. 반대로, 문자열이 정상적으로 숫자로 바뀌더라도 그 값이 도메인 비즈니스 규칙에 부합하는지(예: 최소 결제 금액 100원 이상, 신뢰도 점수 0~100 사이)를 확인하려면 타입 변환이 완전히 끝난 안전한 상태에서 검사해야 한다.

검증 시점을 나누는 기준은 **Pydantic이 원시 입력을 대상 타입으로 변환(Type Casting)하는 시점**이다.

```text
[ 클라이언트 원시 입력: " 150,000 " ]
             │
             ▼
1. Before (전처리 단계)       ───▶ " 150,000 " ➔ "150000" (공백/쉼표 정제)
             │
             ▼
[ Pydantic 코어 타입 변환 ]    ───▶ "150000" (str) ➔ 150000 (int 캐스팅 완료)
             │
             ▼
2. After (도메인 검증 단계)   ───▶ 150000 >= 100 조건 검증 (비즈니스 규칙)
             │
             ▼
[ 최종 안전한 모델 인스턴스 ]  ───▶ amount = 150000

★ Wrap (전체 파이프라인 감싸기)
   위 1번, 코어 변환, 2번 전체를 둘러싸고 실행 제어권(handler)을 행사하는 인터셉터
```

이 타입 변환을 기준으로 **원시 데이터 전처리(`before`)**, **도메인 규칙 검증(`after`)**, 그리고 **예외 복구 및 실행 제어(`wrap`)**의 3가지 역할이 명확하게 구분된다.

---

## 2. 세 가지 검증 모드의 역할과 흐름

Pydantic v2의 `@field_validator`는 `mode` 파라미터를 통해 검증기가 실행될 시점을 결정한다. 각 모드는 처리 목적에 따라 다루는 데이터의 상태와 타입이 다르다.

```python
from typing import Any
from pydantic import BaseModel, field_validator

class PaymentRequest(BaseModel):
    order_id: str
    amount: int

    @field_validator("amount", mode="before")
    @classmethod
    def clean_amount_string(cls, v: Any) -> Any:
        if isinstance(v, str):
            return v.strip().replace(",", "")
        return v

    @field_validator("amount", mode="after")
    @classmethod
    def validate_minimum_amount(cls, v: int) -> int:
        if v < 100:
            raise ValueError("최소 결제 금액은 100원 이상이어야 합니다.")
        return v
```

`mode="before"`는 Pydantic 코어가 타입 변환을 시도하기 직전에 실행된다. 아직 파싱을 거치지 않은 날것의 데이터(Raw Data)가 들어오므로 매개변수 `v`의 타입은 `Any`로 선언하는 것이 표준이다. 이 단계에서 문자열 공백을 잘라내고 쉼표를 제거해 주면, 이어지는 Pydantic 코어 변환기가 정제된 문자열 `"150000"`을 에러 없이 정수 `150000`으로 안전하게 변환한다.

`mode="after"`(기본값)는 Pydantic이 타입을 성공적으로 변환한 직후에 실행된다. 이때 매개변수 `v`는 이미 온전한 `int` 타입임이 보장된다. 만약 `before` 단계에서 `v < 100`을 검사하려 들면, 문자열과 정수를 비교했다는 인터프리터 예외(`TypeError`)가 발생한다. 따라서 타입이 확정된 `after` 단계에서 비즈니스 도메인 규칙을 검증해야 안전하다.

이 검증기 메서드들에 `@classmethod`가 붙는 이유는 객체 생성 라이프사이클과 직결된다. 객체의 인스턴스(`self`)는 모든 필드의 유효성 검증이 통과되어야 비로소 메모리에 생성된다. 검증을 수행하는 시점에는 아직 `self`가 존재하지 않으므로, 인스턴스가 아닌 클래스 자체(`cls`)를 인자로 받는 클래스메서드로 선언한다.

---

## 3. 핸들러 인터셉터와 예외 제어 원리

외부 웹훅이나 데이터 배치 파이프라인에서는 필드에 `"N/A"`, `"UNKNOWN"`과 같이 정제로도 살릴 수 없는 결측치나 이상치가 유입될 수 있다. 기본 `before`나 `after` 검증기는 내부에서 에러가 발생하는 순간 즉시 파이프라인을 중단시키므로, 단 하나의 이상 필드 때문에 대량의 데이터 처리 전체가 멈추는 현상이 발생한다.

이때 사용하는 `mode="wrap"`은 단순한 검증 함수가 아니라, 전체 파이프라인의 실행 제어권을 쥐는 미들웨어 형태의 인터셉터로 동작한다.

```python
from typing import Any
from pydantic import BaseModel, field_validator, ValidationError

class ExtractedEntity(BaseModel):
    entity_name: str
    confidence_score: int

    @field_validator("confidence_score", mode="wrap")
    @classmethod
    def handle_confidence_score(cls, v: Any, handler: Any) -> int:
        # 1. 특정 마스터 조건 즉시 통과
        if v == "MASTER_OVERRIDE":
            return 100

        # 2. 선별적 예외 복구 및 에러 유지
        try:
            return handler(v)
        except ValidationError as e:
            if "int_parsing" in str(e):
                return 0
            raise
```

`mode="wrap"` 검증기는 `(cls, v, handler)` 시그니처를 가진다. 여기서 `handler`는 Pydantic의 코어 타입 변환과 스키마 제약조건 검사를 실행하는 다음 단계의 함수 포인터(Callable)다. `handler(v)`를 직접 호출함으로써 Pydantic에게 검증을 수행하도록 위임하며, 다음과 같이 3가지 방식으로 제어한다:

### 1. 파싱 오류 복구와 기본값 대체
문자열이 깨져서 숫자로 바꾸지 못한 단순 변환 실패(`int_parsing`)는 결측치로 보아 기본 점수인 `0`을 반환하여 전체 프로세스가 멈추지 않도록 안전하게 처리한다.

### 2. 비즈니스 예외 전파와 422 응답
하지만 점수가 `-500`점이거나 `999`점처럼 도메인 규칙을 위반한 심각한 데이터 결함까지 조용히 `0`으로 바꿔서 넘어가면 버그가 숨겨진다.  
따라서 변환 실패가 아닌 규칙 위반 에러는 단독 `raise`를 실행해 에러 상태를 그대로 유지하여 바깥 호출자(FastAPI 프레임워크)로 넘긴다. 모델 내부에서 에러를 덮지 않고 전달해야 FastAPI가 이를 감지하여 클라이언트에게 HTTP 422 Unprocessable Entity 에러 응답을 내려보낼 수 있다.

### 3. 검증 파이프라인 우회 (Bypass)
특수 관리자 플래그(`"MASTER_OVERRIDE"`)가 들어온 경우, `handler(v)`를 실행하지 않고 곧바로 `return 100`을 반환한다. Pydantic의 타입 변환과 검증 체인을 아예 거치지 않고 특정 값을 그대로 통과시킬 수 있다.

---

## 4. 도메인 타입 기반 검증 로직 재사용

클래스 내부에 선언하는 `@field_validator`는 직관적이지만 다른 모델에서 재사용하기 어렵다. 예를 들어 0~100 사이의 백분율 점수나 정제된 금액 규칙을 다루는 모델이 10개 있다면, 10개 클래스마다 동일한 검증 메서드를 복사해서 붙여넣어야 한다. 필드 이름이 다르면 데코레이터 첫 번째 인자까지 일일이 고쳐야 하므로 유지보수 파편화가 발생한다.

이러한 중복을 없애는 방법은 검증 로직을 클래스 바깥의 일반 함수로 분리하고, 파이썬 표준 `typing.Annotated`와 Pydantic v2의 Functional Validator를 이용해 검증 규칙을 '타입'에 직접 결합하는 것이다.

```python
from typing import Annotated, Any
from pydantic import BaseModel
from pydantic.functional_validators import BeforeValidator, AfterValidator

# 1. 독립된 순수 검증 함수
def clean_percent_str(v: Any) -> Any:
    if isinstance(v, str):
        return v.strip().replace("%", "")
    return v

def validate_percent_range(v: int) -> int:
    if not (0 <= v <= 100):
        raise ValueError("점수는 0에서 100 사이여야 합니다.")
    return v

# 2. 재사용 가능한 도메인 타입 정의
PercentageScore = Annotated[
    int,
    BeforeValidator(clean_percent_str),
    AfterValidator(validate_percent_range),
]

# 3. 모델 적용 (클래스 내부 검증기 작성 불필요)
class EntityEvaluation(BaseModel):
    entity_name: str
    confidence_score: PercentageScore

class ModelBenchmark(BaseModel):
    model_name: str
    accuracy: PercentageScore


# ── [실제 인스턴스 생성 및 값 추출] ──
# 1. 인스턴스 생성: 문자열 " 95% "를 전달해도 Before/After를 거쳐 정수 95로 변환
eval_item = EntityEvaluation(entity_name="Disease", confidence_score=" 95% ")

# 2. 일반 속성 조회: 복잡한 래퍼 객체가 아닌 순수 int이므로 즉시 산술 연산 가능
print(eval_item.confidence_score)      # 출력: 95
print(eval_item.confidence_score + 5)  # 출력: 100

# 3. 딕셔너리 추출: model_dump() 호출 시 순수 dict로 안전하게 추출
print(eval_item.model_dump())
# 출력: {'entity_name': 'Disease', 'confidence_score': 95}
```

Pydantic 엔진은 모델 클래스가 초기화될 때 필드의 메타데이터를 분석한다. `confidence_score: PercentageScore`를 확인하는 순간, 기본 타입은 `int`이지만 `BeforeValidator`와 `AfterValidator`가 등록되어 있음을 감지하고 내부 검증 파이프라인에 자동으로 연결한다.

이렇게 선언된 커스텀 타입은 개발자가 사용할 때 일반 파이썬 기본 타입과 완전히 동일하게 동작한다. 검증 파이프라인을 통과한 최종 데이터는 복잡한 래퍼 객체가 아니라 순수 `int`로 저장되므로, 속성 접근 및 산술 연산, 그리고 `model.model_dump()`를 통한 딕셔너리 추출 시에도 아무런 부가 작업 없이 완벽하게 호환된다.

---

## 5. 모델 제약 잠금과 직렬화 보안

검증 계층을 완성한 뒤에는 모델의 동작 모드를 잠그고, 외부로 데이터가 나갈 때의 직렬화 규격을 확립해야 한다.

```python
from pydantic import BaseModel, ConfigDict, computed_field, field_serializer, SecretStr

class SecureAccountPayment(BaseModel):
    model_config = ConfigDict(
        extra="forbid",   # 정의되지 않은 초과 필드 유입 차단
        strict=True,      # 암묵적 타입 변환 차단
        frozen=True,      # 생성 후 속성 변이 불가
    )

    account_number: str
    api_key: SecretStr     # 일괄 은닉: 직렬화 시 자동으로 "**********" 치환
    unit_price: int
    quantity: int

    # 파생 필드: model_dump() 및 API JSON 응답에 정식 포함 보장
    @computed_field
    @property
    def total_price(self) -> int:
        return self.unit_price * self.quantity

    # 비즈니스 가림: 외부 JSON 직렬화 시점에만 자동 마스킹 (내부 원본 유지)
    @field_serializer("account_number", when_used="json")
    def mask_account(self, v: str) -> str:
        return v[:4] + "-****-****"


# ── [실제 인스턴스 생성 및 출력 비교] ──
payment = SecureAccountPayment(
    account_number="1234-5678-9012",
    api_key="sk-secret-key-1234",  # 일반 문자열로 전달하면 SecretStr이 안전하게 감쌈
    unit_price=1000,
    quantity=3,
)

# 1. 외부로 직렬화(JSON)할 때: 자동으로 마스킹되어 안전하게 출력
print(payment.model_dump_json())
# 출력: {"account_number":"1234-****-****","api_key":"**********","unit_price":1000,"quantity":3,"total_price":3000}

# 2. 내부 서버 로직에서 원본 비밀키가 필요할 때: 명시적 메서드로 추출
print(payment.api_key.get_secret_value())
# 출력: "sk-secret-key-1234"
```

### 1. `ConfigDict`를 통한 모델 무결성 잠금
* **`extra="forbid"`**: 권한 탈취를 노린 대량 할당(Mass Assignment) 필드나 오타를 즉시 차단한다.
* **`strict=True`**: `10.8`이 정수 `10`으로 잘려나가는 등 암묵적 형변환에 따른 데이터 왜곡을 방지한다.
* **`frozen=True`**: 동시성 환경에서 인스턴스 변이를 차단하며, 객체를 해시 가능(`__hash__`)하게 만든다.

### 2. 실수에 의존하지 않는 출력 보안 (Secure by Default)
컨트롤러에서 개발자가 수동으로 마스킹 함수를 호출하도록 설계하면, 깜빡 잊고 모델을 그대로 반환했을 때 민감정보가 로그나 응답에 노출되는 위험이 있다.
* **`@field_serializer`**: 비즈니스 로직(PG사 통신)에서는 온전한 원본 계좌번호를 메모리에 유지하고, 외부로 덤프되는 순간에만 자동으로 가로채 마스킹을 강제한다. `when_used="json"`을 지정하면 내부 파이썬 작업(`mode="python"`)에서는 원본이 보존된다.
* **`SecretStr`**: 특정 슬라이싱 규칙 없이 토큰이나 비밀번호 전체를 무조건 숨겨야 한다면 내장 `SecretStr`을 사용한다. 별도 함수 없이 자동으로 `**********`로 은닉되며, 원본이 필요할 때만 `.get_secret_value()`로 꺼내 쓴다.

### 3. `@computed_field`를 통한 직렬화 누락 방어
파이썬 표준 `@property`는 인스턴스에서 직접 조회할 때는 동작하지만, Pydantic의 정식 필드가 아니므로 `model_dump()`나 JSON 변환 시 결과에서 완전히 누락되어 프론트엔드에 `undefined`가 발생하는 버그를 유발한다.  
`@computed_field`를 선언하면 정식 필드로 등록되어 누락 없이 직렬화되며, 클라이언트의 조작 위험은 차단하고(입력 방어) 서버에서 계산한 정확한 값만 외부로 보장(출력 규격 이행)할 수 있다.
