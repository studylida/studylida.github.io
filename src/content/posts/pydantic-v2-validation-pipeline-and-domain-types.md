---
title: "Pydantic v2 데이터 검증 파이프라인과 도메인 타입 설계"
description: "정제되지 않은 입력으로 파싱이 중단되는 문제를 막기 위한 Pydantic v2 필드 검증기(before, after, wrap)와 Annotated 도메인 타입 설계 패턴을 정리한다."
pubDate: "2026-10-19 13:30:00"
tags: ["Pydantic", "FastAPI", "Python", "DataValidation", "Backend"]
categories: ["Backend"]
draft: false
---

## 1. 타입 변환 기준점과 검증 시점

외부 결제 게이트웨이(PG), 웹 프론트엔드 입력 폼, 문서 추출 파이프라인을 연동할 때 서버로 들어오는 원시 데이터는 정제된 상태가 아니다. 금액 필드에 `" 150,000 "`처럼 공백과 쉼표(`,`)가 섞여 있거나, 신뢰도 점수 필드에 `" 95% "`처럼 단위 기호가 붙은 문자열이 자주 전달된다.

Pydantic 모델에서 해당 필드를 정수형(`amount: int`)으로 선언해 두면, Pydantic 파서는 들어온 문자열에 파이썬 `int()` 변환을 시도한다. 이때 쉼표나 퍼센트 기호가 섞여 있으면 변환 단계에서 즉시 `int_parsing` 에러(`ValidationError`)가 발생해 요청 전체가 실패한다. 반면 문자열이 정수로 변환되더라도 최소 결제 금액(100원 이상)이나 점수 범위(0\~100) 같은 도메인 규칙을 만족하는지는 타입 변환이 끝난 뒤 확인해야 한다.

검증 시점을 나누는 기준은 **Pydantic이 원시 입력을 대상 타입으로 변환(Type Casting)하는 시점**이다.

1. **`before` (전처리 단계)**: Pydantic이 타입을 변환하기 전에 `" 150,000 "`에서 공백과 쉼표를 지워 `"150000"`으로 정제한다.
2. **`after` (도메인 검증 단계)**: 코어 엔진이 `"150000"`을 정수 `150000`으로 변환한 뒤 `150000 >= 100` 같은 비즈니스 규칙을 검사한다.
3. **`wrap` (전체 흐름 제어)**: 전처리, 코어 변환, 도메인 검증 전체를 감싸고 다음 단계(`handler`) 호출 여부와 예외 처리를 직접 제어한다.

이 변환 시점을 기준으로 **원시 데이터 전처리(`before`)**, **도메인 규칙 검증(`after`)**, **예외 복구 및 실행 제어(`wrap`)** 세 가지 역할이 나뉜다.

---

## 2. 세 가지 검증 모드

Pydantic v2의 `@field_validator`는 `mode` 파라미터로 검증기가 실행될 시점을 결정한다. 각 모드는 처리 시점에 따라 입력 데이터 상태와 타입이 다르다.

```python
from typing import Any
from pydantic import BaseModel, field_validator

class PaymentRequest(BaseModel):
    order_id: str
    amount: int

    # 1. 코어 타입 변환 직전에 실행되므로 원시 입력(Any)에서 공백과 쉼표를 먼저 제거한다.
    @field_validator("amount", mode="before")
    @classmethod
    def clean_amount_string(cls, v: Any) -> Any:
        if isinstance(v, str):
            return v.strip().replace(",", "")
        return v

    # 2. 정수 변환이 끝난 직후 실행되므로 v는 int임이 보장되며, 안전하게 크기 비교가 가능하다.
    @field_validator("amount", mode="after")
    @classmethod
    def validate_minimum_amount(cls, v: int) -> int:
        if v < 100:
            raise ValueError("최소 결제 금액은 100원 이상이어야 합니다.")
        return v
```

`mode="before"`는 Pydantic 코어가 타입 변환을 시도하기 직전에 실행된다. 아직 파싱을 거치지 않은 원시 데이터(Raw Data)가 들어오므로 매개변수 `v`의 타입은 `Any`로 선언하는 것이 표준이다. 이 단계에서 문자열 공백을 잘라내고 쉼표를 제거해 주면, 이어지는 Pydantic 코어 변환기가 정제된 문자열 `"150000"`을 에러 없이 정수 `150000`으로 변환한다.

`mode="after"`(기본값)는 Pydantic이 타입을 성공적으로 변환한 직후에 실행된다. 이때 매개변수 `v`는 이미 온전한 `int` 타입임이 보장된다. 만약 `before` 단계에서 `v < 100`을 검사하려 들면, 문자열과 정수를 비교했다는 인터프리터 예외(`TypeError`)가 발생한다. 따라서 타입이 확정된 `after` 단계에서 비즈니스 도메인 규칙을 검증해야 안전하다.

이 검증기 메서드들에 `@classmethod`가 붙는 이유는 객체 생성 라이프사이클과 직결된다. 객체의 인스턴스(`self`)는 모든 필드의 유효성 검증이 통과되어야 비로소 메모리에 생성된다. 검증을 수행하는 시점에는 아직 `self`가 존재하지 않으므로, 인스턴스가 아닌 클래스 자체(`cls`)를 인자로 받는 클래스메서드로 선언한다.

---

## 3. wrap 모드와 예외 제어

외부 웹훅이나 배치 파이프라인에서는 `"N/A"`, `"UNKNOWN"`처럼 정제로도 복구할 수 없는 결측치가 종종 들어온다. 기본 `before`나 `after` 검증기는 에러가 나면 파이프라인을 즉시 멈추므로, 이상 필드 하나 때문에 전체 배치 처리가 중단된다.

이때 사용하는 `mode="wrap"`은 코어 타입 변환과 제약 검증 실행(`handler`)을 감싸고 예외를 선별 복구하는 인터셉터로 동작한다.

```python
from typing import Any
from pydantic import BaseModel, Field, ValidationError, field_validator

class ExtractedEntity(BaseModel):
    entity_name: str
    confidence_score: int = Field(ge=0, le=100)

    @field_validator("confidence_score", mode="wrap")
    @classmethod
    def handle_confidence_score(cls, v: Any, handler: Any) -> int:
        # 1. 특수 관리자 조건이면 코어 검증 체인을 건너뛰고 즉시 100을 반환한다.
        if v == "MASTER_OVERRIDE":
            return 100

        # 2. 정수 파싱 자체의 실패(int_parsing)만 0으로 복구하고, 범위 제약 위반(ge/le)은 그대로 전파한다.
        try:
            return handler(v)
        except ValidationError as e:
            if any(err.get("type") == "int_parsing" for err in e.errors()):
                return 0
            raise
```

`mode="wrap"` 검증기는 `(cls, v, handler)` 시그니처를 가진다. 여기서 `handler`는 Pydantic의 코어 타입 변환과 `Field(ge=0, le=100)` 제약 검사를 실행하는 호출 가능한 객체(Callable)다. `handler(v)`를 호출해 기본 검증을 위임한 뒤, 결과에 따라 세 가지로 분기한다.

### 1. 파싱 오류 복구와 기본값 대체
`"N/A"`처럼 문자열 자체가 깨져 정수로 바꾸지 못한 단순 변환 실패(`int_parsing`)는 결측치로 처리한다. 기본 점수 `0`을 반환해 나머지 배치 처리가 멈추지 않게 막는다.

### 2. 도메인 예외 전파와 검증 오류 응답
점수가 `-500`이거나 `999`처럼 `0~100` 범위 규칙을 어긴 결함까지 `0`으로 덮어쓰면 버그가 숨겨진다. 따라서 `e.errors()`의 에러 유형이 `int_parsing`이 아닐 때는 단독 `raise`로 예외를 그대로 넘긴다. FastAPI 같은 웹 프레임워크가 이를 받아 요청을 처리할 수 없음을 알리는 검증 오류 응답(`HTTP 422`)을 클라이언트에 내려보낸다.

### 3. 검증 파이프라인 우회 (Bypass)
특수 관리자 플래그(`"MASTER_OVERRIDE"`)가 들어오면 `handler(v)`를 호출하지 않고 곧바로 `100`을 반환한다. 코어 변환과 범위 검사를 거치지 않고 예외 조건을 통과시키는 구조다.

---

## 4. 도메인 타입 재사용

클래스 내부에 선언하는 `@field_validator`는 직관적이지만 다른 모델에서 재사용하기 어렵다. 예를 들어 0\~100 사이의 백분율 점수나 정제된 금액 규칙을 다루는 모델이 10개 있다면, 10개 클래스마다 동일한 검증 메서드를 복사해서 붙여넣어야 한다. 필드 이름이 다르면 데코레이터 첫 번째 인자까지 일일이 고쳐야 하므로 유지보수 파편화가 발생한다.

이러한 중복을 없애는 방법은 검증 로직을 클래스 바깥의 일반 함수로 분리하는 것이다. 파이썬 표준 `typing.Annotated`와 Pydantic v2의 Functional Validator를 결합하면 검증 규칙 자체를 재사용 가능한 '도메인 타입'으로 묶을 수 있다.

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

Pydantic 엔진은 모델 클래스가 초기화될 때 필드의 메타데이터를 분석한다. `confidence_score: PercentageScore`를 확인하는 순간 기본 타입은 `int`라는 점과 `BeforeValidator`, `AfterValidator` 등록 여부를 함께 파악한다. 이어서 해당 필드를 내부 검증 파이프라인에 자동으로 연결한다.

이렇게 선언된 커스텀 타입은 개발자가 사용할 때 일반 파이썬 기본 타입과 동일하게 동작한다. 파이프라인을 통과한 최종 값은 래퍼 객체가 아니라 순수 `int`로 저장된다. 따라서 일반 속성 접근, 산술 연산, `model.model_dump()` 딕셔너리 추출 시에도 추가 변환 없이 그대로 호환된다.

---

## 5. 모델 제약 잠금과 직렬화 보안

개별 필드 검증을 마쳤더라도 API 응답에서 민감정보가 유출되거나, 요청에 임의의 권한 필드가 섞여 들어와 서버 상태가 변질될 수 있다.

예를 들어 API 핸들러에서 개발자가 수동으로 계좌번호 마스킹 함수를 호출하도록 맡기면, 호출을 한 번 빠뜨리는 순간 원본 계좌번호나 API 키가 응답 JSON이나 로그에 그대로 노출된다. 또한 클라이언트 요청 JSON에 모델에 없는 필드(`is_admin: true` 등)를 함께 보내거나, 금액 숫자 `10.8`이 암묵적으로 `10`으로 버림 변환되어 저장되는 문제도 생긴다.

이를 모델 정의 자체에서 막으려면 `ConfigDict`로 입력 경계를 잠그고, 직렬화 시점의 마스킹과 파생 필드 포함 규칙을 스키마에 선언해야 한다.

```python
from pydantic import BaseModel, ConfigDict, computed_field, field_serializer, SecretStr

class SecureAccountPayment(BaseModel):
    model_config = ConfigDict(
        extra="forbid",   # 1. 스키마에 없는 초과 필드 유입 시 거부
        strict=True,      # 2. 10.8 -> 10 또는 "10" -> 10 같은 암묵적 형변환 차단
        frozen=True,      # 3. 인스턴스 생성 후 필드 값 변이 금지
    )

    account_number: str
    api_key: SecretStr     # 직렬화 시 자동으로 "**********"로 대체되는 비밀 문자열 타입
    unit_price: int
    quantity: int

    # 서버에서 계산하는 파생 필드를 model_dump()와 JSON 출력에 포함시킨다.
    @computed_field
    @property
    def total_price(self) -> int:
        return self.unit_price * self.quantity

    # JSON 직렬화 시점에만 계좌번호 뒷자리를 마스킹하며, 파이썬 메모리 원본은 보존한다.
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
* **`extra="forbid"`**: 스키마에 정의되지 않은 필드(예: 권한 상승을 노린 대량 할당 필드 `is_admin`이나 필드명 오타)가 요청에 들어오면 즉시 거부한다.
* **`strict=True`**: 실수 `10.8`이 정수 `10`으로 잘리거나 문자열 `"10"`이 숫자로 자동 변환되는 왜곡을 막는다. 다만 앞서 `BeforeValidator`로 정제한 문자열 입력까지 허용해야 하는 필드라면 모델 전체 `strict=True`와 충돌할 수 있으므로 적용 범위를 구분해야 한다.
* **`frozen=True`**: 생성 후 속성 변경을 막아 동시성 환경에서 상태 변이를 방지하며, 해시 가능한 객체(`__hash__`)로 사용할 수 있게 한다.

### 2. 실수에 의존하지 않는 출력 보안 (Secure by Default)
API 핸들러에서 매번 마스킹 함수를 수동 호출하도록 두면 한 곳만 누락해도 민감정보가 노출된다.
* **`@field_serializer`**: 내부 결제 연동 로직에서는 원본 계좌번호 문자열을 그대로 쓰되, 외부 API 응답으로 직렬화되는 순간에만 마스킹을 자동 적용한다. `when_used="json"`을 주면 파이썬 딕셔너리 추출(`model_dump()`)에서는 원본 값을 유지할 수 있다.
* **`SecretStr`**: 부분 노출 없이 토큰이나 비밀번호 전체를 가려야 한다면 `SecretStr` 타입을 쓴다. JSON이나 문자열 출력 시 자동으로 `**********`로 치환되며, 실제 값이 필요한 내부 코드에서만 `.get_secret_value()`로 꺼낸다.

### 3. `@computed_field`를 통한 직렬화 누락 방어
파이썬 표준 `@property`는 객체 속성으로 읽을 때는 동작하지만 Pydantic 필드로는 등록되지 않는다. 따라서 `model_dump()`나 JSON 응답 변환 결과에서 빠져 클라이언트에 `undefined`가 전달되는 버그를 일으킨다. `@computed_field`를 함께 선언하면 총액(`total_price`)을 입력에서 받지 않고 서버에서 계산해 안전하게 응답 JSON에 포함할 수 있다.
