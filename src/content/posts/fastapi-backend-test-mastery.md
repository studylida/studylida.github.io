---
title: "FastAPI 테스트 코드 기초부터 DB 격리까지"
description: "코딩 테스트에서 실무 백엔드로 전환하며 학습한 FastAPI와 pytest 기반 테스트 코드 작성법, Pydantic 스키마 방어, 제너레이터 픽스처, SAVEPOINT 롤백 원리를 정리한다."
pubDate: "2026-10-08 09:30:00"
tags: ["FastAPI", "Pytest", "Backend", "TestArchitecture", "SQLAlchemy"]
categories: ["Backend"]
draft: false
---

## 1. 코딩 테스트와 실무 백엔드 개발

알고리즘 문제 풀이를 통해 파이썬 문법을 익히는 것과 웹 프레임워크 환경에서 프로덕션 코드를 작성하는 것 사이에는 상당한 간극이 있다. 코딩 테스트가 단일 함수 안에서 주어진 입력을 처리해 결괏값을 내는 문제 풀이에 가깝다면, 실무 웹 백엔드는 HTTP 프로토콜 규약, 클라이언트 입력값 검증, 영속성 계층(DB) 트랜잭션, 그리고 외부 통신 격리까지 조율해야 한다.

실제 프로젝트인 `ontology-map-workspace` 백엔드(FastAPI + PostgreSQL + SQLAlchemy)를 기반으로 테스트 코드를 작성하며 정리한 기초 문법과 실무 패턴을 단계별로 기록한다.

---

## 2. HTTP 요청과 기본 응답 검증

테스트 코드를 작성할 때 가장 먼저 다루는 부분은 엔드포인트의 기본 상태 코드와 응답 본문 검증이다.

### 2.1 HTTP 요청 방식과 파라미터 전달
웹 API는 목적에 따라 데이터를 전달하는 방식이 다르다:
- **`GET` 요청**: 서버에서 데이터를 조회할 때 사용하며, URL 경로(`/{id}`)나 쿼리 스트링(`params={"q": "검색어"}`)을 통해 조건을 전달한다.
- **`POST` 요청**: 서버에 새 리소스를 생성할 때 사용하며, 본문 페이로드(`json={"name": "이름"}`)에 데이터를 실어 보낸다.
- **요청 헤더(`headers`)**: 인증 토큰(`Authorization`)이나 요청 메타데이터를 담아 보낸다.

FastAPI 테스트에서는 이러한 HTTP 통신을 시뮬레이션하기 위해 `TestClient`를 사용한다. `TestClient`는 실제 네트워크 포트를 열지 않고 메모리 상에서 ASGI 인터페이스를 통해 초고속으로 요청을 처리하는 가상 클라이언트다. 프로젝트의 `conftest.py`에 선언된 `client` 픽스처를 통해 각 테스트 함수에 주입하여 사용한다.

### 2.2 GET 요청과 기본 상태 코드 검증
가장 기초적인 헬스체크 및 404 경로 검증 코드는 다음과 같이 구성된다.

```python
def test_get_health(client: TestClient) -> None:
    """헬스체크 엔드포인트 200 OK 검증."""
    # 1. client.get()으로 가상 HTTP GET 요청을 전송한다.
    response = client.get("/api/v1/health")

    # 2. HTTP 응답 상태 코드가 200(성공)인지 검증한다.
    assert response.status_code == 200

    # 3. 역직렬화된 본문 내용이 기대한 딕셔너리와 같은지 확인한다.
    assert response.json() == {"status": "ok"}


def test_not_found_endpoint(client: TestClient) -> None:
    """존재하지 않는 경로 요청 시 404 Not Found 검증."""
    # 존재하지 않는 경로로 요청을 보낸다.
    response = client.get("/api/v1/invalid-path")

    # 서버가 404 상태 코드를 반환하는지 확인한다.
    assert response.status_code == 404
```

### 2.3 응답 본문 파싱과 방어적 검증
응답 본문에서 세부 필드를 여러 개 검증할 때는 `data = response.json()`과 같이 변수에 역직렬화된 객체를 담아 확인한다. 이때 두 가지 방어적 검증 기법이 필요하다:

1. **`isinstance(data, dict)` 선행 검증**:
   JSON 표준에서 최상위 루트 노드는 객체(`dict`)일 수도 있고 배열(`list`)일 수도 있다. 실제로 목록 조회 API 중 일부는 최상위에 리스트를 바로 반환한다. 본문의 키를 꺼내기 전에 `assert isinstance(data, dict)`를 선행 검증하면, 서버가 예기치 않게 리스트나 에러 문자열을 반환했을 때 발생할 수 있는 런타임 `TypeError`를 방지하고 명확한 `AssertionError`를 통해 결함을 조기에 발견할 수 있다.
2. **`is False` 엄격 비교**:
   로그인 여부나 활성화 상태 같은 불리언 값을 검증할 때 `not data["authenticated"]` 형태의 부정 연산자를 쓰면 위험하다. 파이썬의 `not`은 `False`뿐만 아니라 `0`, `""`, `None`, `[]` 같은 falsy 값을 모두 참으로 판별하기 때문이다. `0`이나 `None`과 명확히 구분하기 위해 싱글톤 비교 연산자인 `is False`를 사용한다.

```python
def test_get_session_unauthenticated(client: TestClient) -> None:
    """비로그인 세션 응답 필드 및 불리언 검증."""
    response = client.get("/api/v1/session")
    assert response.status_code == 200

    # 1. 최상위 본문이 딕셔너리인지 선행 확인한다.
    data = response.json()
    assert isinstance(data, dict)

    # 2. 0이나 None과 구분하기 위해 싱글톤 False를 직접 비교한다.
    assert data["authenticated"] is False
    assert data["user"] is None
```

### 2.4 POST 요청과 201 Created 검증
새로운 데이터를 생성하는 `POST` 요청에서는 `json=` 인자에 파이썬 딕셔너리를 전달한다. 성공 시 응답 코드는 `201 Created`를 기대한다.

```python
def test_create_workspace(client: TestClient) -> None:
    """워크스페이스 생성 성공 시 201 상태 코드 및 반환값 검증."""
    # 1. 전송할 요청 본문 딕셔너리를 준비한다.
    payload = {"name": "연구 프로젝트"}

    # 2. client.post에 json= 인자로 페이로드를 전달한다.
    response = client.post("/api/v1/workspaces", json=payload)

    # 3. 생성 성공을 뜻하는 201 Created 상태 코드를 검증한다.
    assert response.status_code == 201

    # 4. 방어적 타입 검증 후 생성된 이름이 올바르게 반영되었는지 확인한다.
    data = response.json()
    assert isinstance(data, dict)
    assert data["name"] == "연구 프로젝트"
```

---

## 3. 스키마 유효성 검사와 422 방어

백엔드 서버가 처리해야 하는 요청 중 상당수는 클라이언트의 필수값 누락이나 잘못된 타입 전송이다. 잘못된 데이터가 서비스 계층 내부로 진입하여 서버 에러(`500 Internal Server Error`)를 일으키지 않도록, 진입점에서 즉시 차단(`422 Unprocessable Entity`)하는 검증이 필요하다.

### 3.1 Pydantic이 동작하는 위치와 원리
FastAPI는 라우터 내부에서 `if not name:` 같은 수동 유효성 검사 코드를 작성하지 않는다. 대신 Pydantic 라이브러리를 사용하여 진입 계층에서 자동으로 검증한다:

1. **스키마 정의 (`workspace_schemas.py`)**: `BaseModel`을 상속받아 필드 타입과 제약 조건을 선언한다.
   ```python
   from pydantic import BaseModel, ConfigDict, Field

   class WorkspaceCreate(BaseModel):
       # 정의되지 않은 추가 필드가 들어오면 거절하는 설정
       model_config = ConfigDict(extra="forbid")

       # 1글자 이상, 255글자 이하의 필수 문자열
       name: str = Field(min_length=1, max_length=255)
   ```
2. **라우터 연결 (`workspace_api.py`)**: 라우터 함수의 매개변수 타입 힌트로 해당 스키마를 지정한다.
   ```python
   @router.post("/workspaces", status_code=201)
   def create_workspace(body: WorkspaceCreate):
       # 요청 본문이 WorkspaceCreate 규칙을 통과했을 때만 실행된다.
       return workspace_service.create(body)
   ```
3. **자동 차단**: 클라이언트가 `name`을 빼먹거나, `extra="forbid"`로 금지된 임의의 필드를 넣으면 FastAPI가 라우터 함수 본문을 실행하지 않고 즉시 `422 Unprocessable Entity`를 반환한다.

### 3.2 422 에러의 세부 필드 검증
단순히 `assert response.status_code == 422`나 `"detail" in data` 수준으로만 단언하면 잘못된 테스트 통과(False Positive)가 발생할 수 있다.

예를 들어, 허용되지 않은 `owner_user_id` 필드를 보냈을 때 거절되는지 확인하려는 테스트에서 실수로 필수값인 `name`까지 누락한 경우를 들 수 있다. 단순 상태 코드만 보면 422이므로 테스트는 통과하지만, 실제로 검증하려 했던 `owner_user_id` 방어 로직은 전혀 검증되지 않은 셈이다.

따라서 에러 응답 배열(`detail`)에서 어느 필드(`loc`)가 어떤 이유(`type`)로 거절되었는지 확인해야 한다.

```python
def test_workspace_create_rejects_extra_fields(client: TestClient) -> None:
    """정의되지 않은 필드 주입 시 422 상태 코드 및 에러 원인 검증."""
    # 허용되지 않은 owner_user_id 필드를 포함하여 전송한다.
    payload = {"name": "새 프로젝트", "owner_user_id": 999}
    response = client.post("/api/v1/workspaces", json=payload)

    # 1. 422 상태 코드를 확인한다.
    assert response.status_code == 422

    # 2. 응답 본문이 딕셔너리이고 detail 필드를 포함하는지 확인한다.
    data = response.json()
    assert isinstance(data, dict)
    assert "detail" in data

    # 3. 에러 발생 위치와 에러 타입을 구체적으로 검증한다.
    error = data["detail"][0]
    assert error["loc"] == ["body", "owner_user_id"]
    assert error["type"] == "extra_forbidden"
```

---

## 4. 파라미터 전달과 방어적 조회

데이터 조회 API에서는 검색어, 페이지네이션 한도, 정렬 기준 등을 쿼리 스트링으로 전달하고, 특정 리소스 접근 시 경로 변수를 사용한다. 또한 인증 정보는 HTTP 헤더로 전달된다.

### 4.1 쿼리 파라미터 검색 테스트
`client.get()` 호출 시 `params=` 인자에 딕셔너리를 전달하면 URL 뒤에 `?q=연구` 형태의 쿼리 스트링이 붙어서 전송된다.

```python
def test_search_workspaces_by_query(client: TestClient) -> None:
    """쿼리 파라미터를 통한 검색 API 호출."""
    query = {"q": "연구"}
    response = client.get("/api/v1/workspaces", params=query)

    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, dict)
```

### 4.2 인덱스 참조의 함정과 in 연산자 방어
위 검색 결과에서 반환된 항목을 검증할 때, 다음과 같이 0번째 인덱스를 직접 단언하는 방식은 취약하다:

```python
# 위험한 단언: 결과가 비어있으면 IndexError 발생, 정렬 순서가 바뀌면 테스트 실패
assert data["items"][0]["name"] == "연구 프로젝트"
```

DB 조회 결과의 정렬 순서가 보장되지 않거나 검색 결과가 0건일 때 인덱스 접근은 테스트를 깨뜨린다. 리스트 컴프리헨션과 `in` 연산자를 조합하면 순서에 영향을 받지 않는 안전한 단언문을 작성할 수 있다:

```python
# 안전한 단언: items 내부의 name들 중 원하는 값이 존재하는지만 검사
names = [item["name"] for item in data["items"]]
assert "연구 프로젝트" in names
```

### 4.3 경로 변수(Path Parameter) 조회
URL 경로 자체에 ID가 포함되는 엔드포인트는 파이썬의 f-string을 활용해 경로를 구성한다.

```python
def test_get_workspace_by_id(client: TestClient) -> None:
    """경로 변수를 사용한 단건 상세 조회 검증."""
    target_id = "ws-1"
    response = client.get(f"/api/v1/workspaces/{target_id}")

    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, dict)
    assert data["id"] == target_id
    assert data["name"] == "연구 프로젝트"
```

### 4.4 HTTP 헤더 전달과 인증 실패 검증
웹 API에서는 일반적으로 `Authorization` 헤더를 통해 인증 토큰을 전달한다. 테스트 코드에서는 `headers=` 인자를 통해 임의의 헤더를 주입할 수 있다. 잘못된 토큰을 전송했을 때 401 Unauthorized로 거절되는지 확인한다.

```python
def test_get_workspaces_rejects_invalid_token(client: TestClient) -> None:
    """유효하지 않은 토큰 헤더 전송 시 401 에러 검증."""
    # Authorization 헤더에 잘못된 토큰을 실어 전송한다.
    headers = {"Authorization": "Bearer invalid_secret_token"}
    response = client.get("/api/v1/workspaces", headers=headers)

    assert response.status_code == 401
    data = response.json()
    assert isinstance(data, dict)
    assert "detail" in data
```

---

## 5. 픽스처 생명주기와 의존성 격리

테스트 함수마다 반복되는 데이터 생성이나 클라이언트 설정을 직접 작성하면 중복이 발생한다. pytest는 `@pytest.fixture` 데코레이터를 통해 테스트 준비물(Fixture)을 모듈화하고 재사용할 수 있게 한다.

### 5.1 conftest.py의 실용적 의미
프로젝트 루트나 `tests/` 디렉터리에 위치한 `conftest.py`는 pytest 러너가 자동으로 인식하는 특수 설정 파일이다. 이 파일에 선언된 Fixture 함수들은 별도의 `import` 문 없이도 하위의 모든 테스트 파일에서 인자 이름만 맞추면 자동으로 주입된다.

```python
# tests/conftest.py
@pytest.fixture
def sample_workspace_payload() -> dict[str, str]:
    """공통 테스트용 워크스페이스 페이로드."""
    return {"name": "픽스처 프로젝트"}

# tests/test_workspaces.py
def test_create_workspace_using_fixture(
    client: TestClient, sample_workspace_payload: dict[str, str]
) -> None:
    # sample_workspace_payload를 import 없이 바로 주입받아 사용한다.
    response = client.post("/api/v1/workspaces", json=sample_workspace_payload)
    assert response.status_code == 201
```

### 5.2 app.dependency_overrides와 뒷정리 누락 문제
FastAPI는 `app.dependency_overrides`를 제공한다. 이는 딕셔너리 구조로 동작한다:
- **Key**: 대체하고자 하는 원래의 의존성 함수 (예: `get_current_user`)
- **Value**: 대신 실행할 가짜 함수나 람다 (예: `lambda: {"username": "alice"}`)

그러나 테스트 함수 안에서 의존성을 주입하고 마지막에 수동으로 초기화하는 코드는 잠재적 결함을 지닌다:

```python
def test_profile(client: TestClient) -> None:
    app.dependency_overrides[get_current_user] = lambda: {"username": "alice"}
    response = client.get("/api/v1/profile")
    assert response.status_code == 200

    # 만약 위 assert문이 실패하면 아래 코드는 실행되지 않는다!
    app.dependency_overrides.clear()
```

단언문이 실패하여 예외가 발생하면 `clear()`가 호출되지 않은 채 테스트가 종료된다. 그 결과 이후에 실행되는 다른 테스트 함수들까지 오염된 가짜 인증 정보를 참조하게 된다.

### 5.3 yield, finally, 그리고 Generator 타입 힌트
이 상태 오염을 방지하기 위해 Fixture 내부에서 `yield`와 `try...finally`를 사용한다:

1. `yield` 이전: 테스트 실행 전 준비 단계(Setup)
2. `yield` 시점: 준비된 객체를 테스트 함수에 전달하고 대기
3. `finally` 블록: 테스트 함수가 정상 종료되든 중간에 `assert` 실패로 예외가 터지든 상관없이 반드시 실행되는 정리 단계(Teardown)

이때 함수 내부에서 `yield`를 사용하므로 파이썬의 표준 `Generator` 타입 힌트를 지정해야 한다. `Generator[YieldType, SendType, ReturnType]`의 세 가지 인자는 다음 의미를 가진다:
- **`YieldType` (`TestClient`)**: `yield` 키워드를 통해 테스트 함수에 전달해 주는 객체의 타입.
- **`SendType` (`None`)**: 제너레이터 외부에서 `.send()` 메서드로 주입받을 값의 타입 (테스트 Fixture에서는 사용하지 않으므로 `None`).
- **`ReturnType` (`None`)**: 제너레이터가 완전히 종료될 때 최종 `return`하는 값의 타입 (Fixture에서는 반환값이 없으므로 `None`).

```python
@pytest.fixture
def signed_client(client: TestClient) -> Generator[TestClient, None, None]:
    """테스트 예외 발생 시에도 의존성을 안전하게 원상 복구하는 인증 픽스처."""
    # 1. Setup: 가짜 로그인 사용자 주입
    app.dependency_overrides[get_current_user] = lambda: {"username": "alice"}
    try:
        # 2. 테스트 함수로 제어권과 client를 넘김
        yield client
    finally:
        # 3. Teardown: 테스트 실패 여부와 상관없이 무조건 의존성 초기화
        app.dependency_overrides.clear()


def test_profile_with_safe_signed_client(signed_client: TestClient) -> None:
    response = signed_client.get("/api/v1/profile")
    assert response.status_code == 200
    assert response.json()["username"] == "alice"
```

---

## 6. 데이터베이스 검증과 롤백 격리

백엔드 애플리케이션의 핵심 로직 대부분은 데이터베이스와 상호작용한다. 그러나 데이터베이스 테스트를 잘못 작성하면 단순 메모리 변수만 확인하고 넘어가거나, 테스트 실행 후 잔여 데이터로 인해 DB가 오염된다.

### 6.1 객체 검사의 한계와 재조회의 필요성
테스트 코드에서 SQLAlchemy 모델 인스턴스를 생성하고 다음과 같이 작성하는 경우가 있다:

```python
new_workspace = Workspace(name="데이터베이스 지도")
db_session.add(new_workspace)
db_session.flush()

# 위험한 검증: 이는 파이썬 변수 new_workspace.name을 읽은 것일 뿐이다.
assert new_workspace.name == "데이터베이스 지도"
```

파이썬 객체 변수를 직접 검사하면, 실제 DB 엔진의 컬럼 제약조건(외래키, Not Null, Unique 인덱스 등)에 걸려 쓰기가 실패했더라도 이를 포착하지 못할 수 있다. 쓰기 작업 후 **데이터베이스 엔진에서 실제로 데이터를 다시 조회(SELECT)해 올 수 있는지** 확인해야 진짜 DB 검증이 된다.

```python
new_workspace = Workspace(name="진짜 DB 지도")
db_session.add(new_workspace)
db_session.flush()

# 실제 DB에서 기본키(ID)를 통해 레코드를 다시 읽어온다.
saved = db_session.get(Workspace, new_workspace.id)
assert saved is not None
assert saved.id == new_workspace.id
assert saved.name == "진짜 DB 지도"
```

### 6.2 db_session.get과 select의 차이점
그렇다면 DB에서 데이터를 다시 꺼내올 때 어떤 방식을 사용하는 것이 적절할까? SQLAlchemy 2.0에서는 상황에 따라 두 가지 방식을 구분해 사용한다:

- **`db_session.get(Model, pk)`**:
  - 기본키(Primary Key)로 단건 조회할 때 가장 직관적이고 빠르다.
  - 내부적으로 SQLAlchemy의 1차 캐시(Identity Map)를 조회한 뒤 필요한 경우 쿼리를 수행한다.
- **`select(Model).where(...)` + `scalar_one_or_none()`**:
  - 기본키가 아닌 다른 컬럼(예: `email`, `code`)이나 복합 조건으로 조회할 때 필수적이다.
  - 조건에 부합하는 레코드가 2개 이상일 경우 `MultipleResultsFound` 예외를 던지므로, 테이블의 유일성(Unique) 제약 조건이 의도대로 유지되는지 검증할 때 매우 유용하다.

### 6.3 SAVEPOINT 중첩 트랜잭션 롤백
실제 PostgreSQL 데이터베이스에 데이터를 쓰면서 테스트를 수행하면, 테스트가 끝난 뒤 테이블에 레코드가 계속 쌓여 다음 테스트에 영향을 미친다. 매번 테이블을 TRUNCATE하거나 삭제하는 방식은 속도가 지나치게 느려진다.

이를 해결하기 위해 테스트 시작 시 트랜잭션을 열고, 테스트 종료 시 `transaction.rollback()`을 호출하여 모든 변경 사항을 없던 일로 되돌린다. 이때 서비스 코드 내부에서 `session.commit()`을 호출하더라도 전체 롤백이 가능해야 하므로, SQLAlchemy의 `join_transaction_mode="create_savepoint"` 옵션을 활용한다:

```python
# tests/conftest.py
@pytest.fixture
def db_session() -> Generator[Session, None, None]:
    """SAVEPOINT 모드로 각 테스트의 DB 변경사항을 자동 롤백하는 픽스처."""
    connection = get_engine().connect()
    transaction = connection.begin()

    # 내부에서 commit이 발생해도 외부 트랜잭션을 보존하도록 savepoint 모드 지정
    session = Session(bind=connection, join_transaction_mode="create_savepoint")

    yield session

    # 테스트 종료 후 세션을 닫고 트랜잭션을 완전히 되돌린다.
    session.close()
    transaction.rollback()
    connection.close()


@pytest.fixture
def client(db_session: Session) -> Generator[TestClient, None, None]:
    """DB 세션이 롤백 세션으로 오버라이드된 TestClient."""
    app.dependency_overrides[open_session] = lambda: db_session

    with TestClient(app) as test_client:
        yield test_client

    app.dependency_overrides.clear()
```

이 설정을 적용하면 테스트가 실행되는 동안에는 실제 DB에 데이터가 기록되고 조회가 가능하지만, 테스트가 끝나는 순간 트랜잭션이 롤백되어 DB가 깨끗한 초기 상태를 유지한다.

---

## 7. 외부 통신 차단과 몽키패치 활용

백엔드 시스템이 OpenAI API나 결제 게이트웨이 같은 외부 네트워크 서비스와 연동되어 있을 때, 테스트 실행 도중 실수로 실제 외부 서버로 HTTP 요청이 나가는 것은 반드시 차단해야 한다. 불필요한 API 비용이 발생할 뿐만 아니라, 네트워크 지연으로 인해 테스트 실행 속도가 느려지고 외부 장애에 영향을 받기 때문이다.

### 7.1 dependency_overrides의 한계와 monkeypatch의 등장
앞선 5장에서 FastAPI의 `app.dependency_overrides`를 통해 가짜 사용자를 주입하는 법을 배웠다. 그렇다면 외부 API 통신도 `dependency_overrides`로 막을 수 없을까?

`dependency_overrides`는 FastAPI 라우터에서 `Depends()`를 통해 명시적으로 주입된 의존성에만 작동한다. 그러나 서비스 계층 내부나 서드파티 SDK 코드에서 직접 `httpx.Client()`나 `requests`를 생성하여 호출하는 라이브러리 레벨의 통신은 FastAPI의 DI 컨테이너를 거치지 않는다.

따라서 파이썬 런타임 메모리 상에서 해당 HTTP 클라이언트 메서드 자체를 가로채는 `monkeypatch`가 필요하다. 단순 대입(`httpx.Client.post = fake`)을 사용하면 테스트 실패 시 원본 함수로 복구되지 않지만, pytest의 내장 `monkeypatch` 픽스처는 변경 전 원본 함수의 참조를 백업해 두었다가 테스트 종료 시 안전하게 원상 복구해 준다.

### 7.2 monkeypatch.setattr의 인자 구조와 autouse 픽스처
프로젝트 전역에서 모킹되지 않은 외부 HTTP 요청이 발생하는 것을 막기 위해 `autouse=True` 픽스처를 설정한다.

```python
@pytest.fixture(autouse=True)
def reject_model_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    """테스트 도중 모킹되지 않은 외부 HTTP 요청이 발생하면 즉시 예외를 발생시킨다."""
    # 1. 호출 시 항상 AssertionError를 발생시키는 가짜 함수를 정의한다.
    #    *args와 **kwargs를 지정하여 어떤 URL, 파라미터가 들어오든 전부 받아낸다.
    def forbidden(*args: object, **kwargs: object) -> None:
        raise AssertionError("테스트 도중 허가되지 않은 외부 HTTP 요청 발생")

    # 2. monkeypatch.setattr로 원래의 post 메서드를 위 forbidden 함수로 교체한다.
    #    - 첫 번째 인자: 대체당할 대상 객체 경로 문자열 ("모듈.클래스.메서드")
    #    - 두 번째 인자: 대체하여 실행할 새로운 가짜 함수
    monkeypatch.setattr("httpx.Client.post", forbidden)
    monkeypatch.setattr("httpx.AsyncClient.post", forbidden)
```

- **`autouse=True`**: 개별 테스트 함수의 매개변수에 `reject_model_calls`를 일일이 적지 않아도, pytest 러너가 테스트 스위트 내의 모든 테스트 함수에 대해 자동으로 이 픽스처를 활성화한다.
- **`*args: object, **kwargs: object`**: `httpx.post("https://...")`가 내부적으로 어떤 URL, 헤더, 타임아웃 인자를 전달하더라도 에러 없이 모두 흡수하여 곧바로 차단 예외를 던지도록 가변 인자로 구성한다.

### 7.3 with pytest.raises를 통한 차단 동작 검증
위 차단 장치가 실제로 작동하는지 검증하기 위해 `with pytest.raises(...)` 컨텍스트 매니저를 사용할 수 있다.

```python
def test_external_call_is_blocked() -> None:
    """외부 HTTP 클라이언트 호출 시 AssertionError가 발생하는지 확인."""
    # 1. with pytest.raises() 블록 내부에서 특정 예외가 반드시 발생해야 함을 선언한다.
    #    만약 블록 내부에서 예외가 발생하지 않고 정상 종료되면 테스트는 실패 처리된다.
    #    'as exc_info'는 실제로 발생한 예외 객체를 캡처하여 변수에 담는다.
    with pytest.raises(AssertionError) as exc_info:
        # 차단된 httpx 클라이언트로 외부 요청 시도
        client = httpx.Client()
        client.post("https://api.openai.com/v1/chat")

    # 2. 캡처된 예외(exc_info.value)에서 에러 메시지를 꺼내 기대한 문자열인지 확인한다.
    assert "테스트 도중 허가되지 않은 외부 HTTP 요청 발생" in str(exc_info.value)
```

이러한 방어막을 구축해 두면, 개발자가 테스트를 작성할 때 외부 통신 모킹을 깜빡하더라도 실제 네트워크로 요청이 새어 나가지 않고 테스트 프레임워크가 즉시 실패를 알려주므로 안전한 테스트 환경을 유지할 수 있다.
