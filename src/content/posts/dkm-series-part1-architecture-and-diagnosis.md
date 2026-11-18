---
title: "DKM 아키텍처 1편: 사내 지식 RAG의 5계층 구조와 오류 진단"
description: "사내 도메인 지식 관리(DKM) 시스템의 5가지 지식 역할, PostgreSQL 단일 저장소 기반 모듈러 모놀리스와 5계층 경계, 두 가지 비동기 실행 흐름과 배치 SSE 저장, 단계별 오류 진단 기준을 정리한다."
pubDate: "2026-11-18 12:35:00"
tags: ["DKM", "RAG", "Architecture", "FastAPI", "PostgreSQL", "SSE", "Python"]
categories: ["Architecture", "AI"]
draft: false
---

사내 기술 문헌과 시험 데이터를 다루는 조직에서는 일반 검색 증강 생성(RAG) 데모만으로 업무를 처리하기 어렵다. 문서는 계속 수정되거나 철회되고, 같은 약어가 공정마다 다른 뜻을 가지며, CSV 시험 기록에서는 문장 유사도가 아니라 정확한 분모와 분자 계산이 필요하다.

이러한 요구를 해결하기 위해 사내 도메인 지식 관리 시스템(Domain Knowledge Management, DKM)을 설계하고 `v1.0.0`부터 `v1.8.14`까지 단계적으로 확장했다. 8부작 시리즈의 첫 편인 이 글에서는 DKM이 다루는 5가지 지식의 역할과 모듈러 모놀리스 5계층 구조, 두 가지 비동기 처리 흐름, 그리고 답변 오류가 발생했을 때 원인을 추적하는 단계별 진단 기준을 정리한다.

---

## 1. DKM의 문제와 지식 체계

신규 담당자가 검사 장비를 맡아 `"이번 조건에서도 기존 시험 절차를 그대로 써도 되는가?"`라고 물었다고 가정한다. 이때 필요한 정보는 단일 PDF 파일 하나에 들어 있지 않다.

원래 규격은 시험 안내서에 적혀 있지만, 현장에서 왜 그 조건을 골랐는지에 대한 풀이는 앞선 담당자의 위키에 남는다. 문서 안의 낯선 약어는 단어사전이 풀어 주고, 실제 시험 건수와 합격률은 CSV 기록이 가진다. 따라서 DKM은 사내 지식을 다섯 가지 역할로 나누어 다룬다.

| 지식 유형 | 담당하는 질문과 역할 | 읽을 때 분리해야 하는 경계 |
|---|---|---|
| **공용 문헌** | 원래 안내서와 기술 자료가 명시한 절차, 수치, 조건 | 제목만 보고 내용을 추측하지 않고 해당 원문 구간을 확인한다. |
| **공용 위키** | 문헌의 절차를 사내 업무 맥락에 맞춰 정리한 설명과 이력 | 원문 사실, 작성자의 해석, 미확인 의견을 서로 섞지 않는다. |
| **단어사전** | 사내에서 쓰이는 약어와 전문 용어의 정의 및 별칭 | 같은 표기라도 도메인이나 맥락에 따라 뜻이 달라질 수 있다. |
| **업무 판단 지식** | 특정 조건에서 왜 그 방법을 선택했는지 기록한 의사결정 맥락 | 과거의 결론을 조건이 다른 새 업무에 그대로 복사하지 않는다. |
| **CSV와 계산 결과** | 실제 시험 기록에서 조건별로 집계한 건수, 분모, 비율 | 원본 행, 선택한 필터 조건, 저장된 계산 결과를 구분한다. |

DKM의 사용 흐름은 일회성 질의응답에서 멈추지 않는다. 직원이 기존 지식을 바탕으로 질문을 던지면 시스템이 근거 각주와 함께 답변을 생성한다. 사용자는 각주를 눌러 원본 문헌의 해당 구간을 직접 대조한 뒤, 부족한 자료가 있으면 새 문헌을 추가하거나 위키에 맥락을 보완해 다음 담당자가 재사용할 수 있게 남긴다.

---

## 2. 모듈러 모놀리스와 5계층

DKM(`v1.0.0` \~ `v1.8.14`)은 별도의 메시지 큐 서버(RabbitMQ, Kafka 등)나 그래프 데이터베이스를 따로 띄우지 않고, 하나의 백엔드 서버와 하나의 PostgreSQL(벡터 검색용 pgvector 확장 포함)만으로 동작하는 **모듈러 모놀리스(Modular Monolith)** 구조다. 인증, 대화 기록, 문헌, 임베딩, 작업 대기열, 위키가 모두 한 DB 안에서 일관된 트랜잭션을 공유한다.

하나의 백엔드 프로세스로 묶어 두되 내부 코드까지 거대한 파일 하나에 섞이면 테스트와 유지보수가 어려워진다. 이를 해결하기 위해 DKM은 애플리케이션 진입점(`backend/knowledge/main.py`)의 `create_app()` 함수에서 기능별 서비스들을 조립할 때 두 가지 문제를 코드 수준에서 방지한다.

1. **모델 클라이언트를 서비스 파일 내부에 직접 고정해 테스트가 막히는 문제**: 만약 답변 서비스 파일 내부에서 특정 유료 LLM API 객체를 직접 생성해 고정(하드코딩)해 두면, 자동화 테스트를 실행할 때마다 실제 과금이 발생하고 테스트용 가짜 모델로 교체할 수 없다. DKM은 필요한 DB 연결과 AI 모델 객체를 각 서비스 파일 내부에 숨기지 않고 `create_app()` 함수의 인자로 외부에서 전달받도록 설계했다.
2. **서버를 켰을 때 작업이 자동 실행되어 과금이나 충돌을 일으키는 문제**: 웹 서버가 켜질 때 편의상 DB 테이블을 최신으로 자동 수정하거나 중단된 문서 색인을 자동으로 재개하도록 구현하면, 상태를 확인하려고 서버만 잠깐 켰는데 유료 AI 호출이 발생하거나 이미 실행 중인 별도 작업 프로세스와 DB 잠금이 충돌할 수 있다. 따라서 서버 기동 시점에는 설정 검증만 수행하고, 데이터 변경이나 AI 호출은 명시적 API 요청이나 별도 워커 프로세스로만 실행되게 제한했다.

실제 `create_app()` 코드가 이 두 가지 규칙을 어떻게 구현하는지 주석과 함께 살펴보자.

```python
# backend/knowledge/main.py — 외부 부품 전달과 안전한 서버 기동 경계 설정
def create_app(
    settings=None,                  # 환경변수·DB 주소·모델 설정이 담긴 설정 객체
    session_factory=None,           # PostgreSQL 연결 세션을 생성하는 팩토리 함수
    *,                              # 아래 인자들은 키워드 이름(예: generation_client=...)으로만 전달
    embedding_client=None,          # 테스트 시 가짜 임베딩 객체를 전달하기 위한 선택 인자
    generation_client=None,         # 테스트 시 가짜 LLM 객체를 전달하기 위한 선택 인자
    reranker=None,                  # 검색 결과를 재정렬할 선택적 리랭커 모델
    query_generation_client=None,   # 질의 보완용 경량 모델(선택)
):
    settings = settings or get_settings()

    # [규칙 1] 모델 클라이언트와 DB 연결을 서비스 내부에 고정하지 않고 외부 인자로 전달한다.
    # SimpleNamespace는 속성 접근(services.answers 등)이 가능한 가벼운 묶음 객체다.
    # 테스트 실행 시 generation_client에 가짜 객체를 넘기면 실제 유료 LLM을 호출하지 않는다.
    services = SimpleNamespace(
        identity=IdentityService(session_factory, settings),
        conversations=ConversationService(session_factory),
        documents=DocumentService(session_factory, settings),
    )
    # 인자로 모델이 넘어오면(테스트용) 그대로 쓰고, None이면(운영 시) 설정에서 실제 모델을 생성한다.
    rag = RAGService(session_factory, settings, embedding_client or get_embedding_client(settings), reranker)
    services.reading = ReadingService(session_factory)
    services.evidence = EvidenceService(session_factory, settings)
    services.wiki = WikiService(session_factory)
    services.answers = AnswerService(
        session_factory, settings, services.identity, rag,
        generation_client or get_generation_client(settings),
        query_generation_client, evidence=services.evidence,
    )

    # [규칙 2] FastAPI lifespan: 웹 서버가 켜질 때(yield 위)와 꺼질 때(yield 아래) 한 번 실행되는 구간이다.
    # 여기서 DB 테이블을 변경하거나 중단됐던 AI 색인을 자동 재개하면 의도치 않은 과금과 충돌이 생긴다.
    @asynccontextmanager
    async def lifespan(app):
        check_secret(settings)          # 로그인 토큰 서명용 비밀키가 비어 있거나 약하지 않은지 확인
        load_entities()                 # DB 테이블 정의 클래스들을 메모리에 등록
        async with session_factory() as session:
            await assert_current_schema(session)  # DB 스키마 버전이 코드와 맞는지 읽기 검사만 수행
        yield                           # 이 시점부터 실제 HTTP 요청 수신 시작 (자동 작업 시작 금지)

    app = FastAPI(title='Company Knowledge Assistant', version=__version__, lifespan=lifespan)

    # 기능 도메인별로 나뉜 API 라우터 12개를 /api/v1 경로 아래에 등록한다.
    for router in (
        identity_router, conversation_router, document_router, answer_router,
        wiki_router, wiki_search_router, proposal_router, document_wiki_router,
        reading_router, links_router, status_router, evidence_router
    ):
        app.include_router(router, prefix='/api/v1')
    return app
```

이처럼 도메인별로 나뉜 각 패키지(`documents`, `rag`, `answers` 등)와 프론트엔드(`frontend/src/`) 내부는 다시 다섯 계층으로 책임을 나눈다.

| 계층명 | 백엔드(`backend/knowledge/*`) 책임 | 프론트엔드(`frontend/src/*`) 책임 |
|---|---|---|
| **View** | — | 목록, 질문 입력, 답변 본문, 각주 및 원문 패널 렌더링 |
| **Controller** | `router.py` — HTTP 요청 수신, 로그인 검사, 응답 반환 | `controllers/` — 버튼 클릭 등 사용자 동작과 화면 상태 제어 |
| **Service** | `service.py` — 접근 권한, 판본 규칙, 조회와 모델 호출 조합 | `services/` — 서버에서 받은 실시간 응답 조각과 각주 번호 조립 |
| **Repository** | `repository.py` — PostgreSQL 조회 및 저장, 동시 수정 잠금 실행 | `repositories/` — 서버 API와 HTTP 통신, 브라우저 저장소 관리 |
| **Entity / DTO** | `entities.py`, `dto.py` — DB 테이블 모델 및 API 입출력 형식 정의 | `types/` — 서버와 주고받는 요청 및 응답 데이터 형태 정의 |

같은 `Repository`라는 이름을 쓰더라도 백엔드에서는 DB와 통신하고, 프론트엔드에서는 백엔드 API와 통신한다. 이렇게 계층을 나누어 두면 화면에 표시용 상태를 그리는 코드와 실제 DB 상태를 변경하는 코드가 한 파일에서 뒤섞이지 않는다.

PostgreSQL 데이터베이스 스키마(`backend/migrations/v3/`) 역시 단순히 테이블을 나열한 것이 아니라, **함께 두면 문제가 생기는 데이터들을 성격별로 분리하기 위해** 네 묶음으로 나누었다.

1. **개인 작업 공간(사용자, 대화, 메시지)**: 직원 계정 정보(`knowledge_users`)와 개인이 진행한 대화방(`conversations`), 주고받은 메시지(`messages`)를 둔다. 공용 문헌과 분리해 두어야 관리자가 공용 자료를 관리하더라도 타인의 개인 질문 기록까지 열람하지 못하게 소유권 경계를 강제할 수 있다.
2. **공용 문헌과 비동기 준비(문헌, 판본, 구간, 벡터, 작업 큐)**: 문헌의 대표 정보(`documents`), 파일이 수정될 때마다 쌓이는 버전 기록(`document_revisions`), 자른 텍스트 조각(`passages`), 임베딩 캐시(`embedding_records`), 실제 벡터(`passage_embeddings`), 작업 대기열(`processing_jobs`)을 분리했다. 파일을 서버에 저장한 사실과 검색 준비가 끝난 사실을 분리해야, 아직 색인 중인 미완성 문서가 검색에 섞여 나오는 오류를 막을 수 있다.
3. **실행 복원과 검색 추적(검색 기록, 답변 실행, 이벤트 배치)**: 질문마다 검색기가 찾은 후보 기록(`retrieval_runs`), 답변 생성의 진행 상태(`answer_runs`), 응답 조각을 묶어 둔 배치(`answer_event_batches`)를 영구 저장한다. 생성 결과를 메모리에만 유지하지 않고 DB에 남겨 두어야, 사용자가 답변 도중 브라우저를 새로고침해도 작성되던 답변과 출처를 복원할 수 있다.
4. **공용 지식 확장(위키, 의미 모델, 계산 스냅샷)**: 이후 단계에서 추가된 테이블들이다. 직원들이 함께 편집하는 위키 이력과 CSV 컬럼의 의미 명세, 저장된 계산 결과를 별도 테이블로 추가해 기존 대화 및 문헌 스키마를 수정하지 않고 확장한다.

---

## 3. 비동기 접수와 워커 실행

앞에서 나눈 테이블과 5계층 위에서 실제로 가장 시간이 오래 걸리는 작업은 두 가지다. 하나는 직원이 올린 **문헌을 읽고 벡터로 색인하는 쓰기 경로**이고, 다른 하나는 직원의 **질문에 대해 근거를 찾고 답변을 한 글자씩 생성하는 응답 경로**다.

두 경로 모두 수 초에서 수 분까지 걸릴 수 있어서, 일반적인 웹 요청 한 번 안에서 모든 처리가 끝날 때까지 기다리면 HTTP 연결 시간이 초과되거나 중간 상태를 복구하기 어렵다. 그래서 DKM은 두 경로 모두 요청을 받자마자 일단 접수 확인을 뜻하는 HTTP **`202 Accepted`** 상태 코드만 즉시 반환한 뒤, 각 경로의 성격에 맞게 뒤에서 비동기로 처리한다.

### 1) 문헌 업로드 접수와 별도 워커 (`POST /documents` ➔ `worker.py`)

문서를 올릴 때 흔히 빠지는 함정은 **파일 업로드를 완료한 상태**와 **검색이 가능한 상태**를 똑같이 취급하는 것이다. 예를 들어 기존에 검색으로 잘 쓰이던 사내 안내서의 수정본을 새로 올렸다고 가정한다. 새 파일이 디스크에 저장됐더라도 뒤에서 텍스트를 읽고 벡터로 바꾸는 작업이 아직 끝나지 않았다면, 시스템은 그동안 기존에 준비가 끝나 있던 이전 버전(활성 판본)을 검색에 계속 사용해야 한다. 반대로 처음 등록한 문서라면 색인이 끝나기 전까지는 검색 대상에 들어가면 안 된다.

아래 `DocumentService.upload()` 코드는 HTTP 요청 안에서 시간이 오래 걸리는 파싱이나 임베딩 모델을 전혀 부르지 않고, 오직 **원본 파일 저장과 작업 대기열 등록까지만 한 번의 DB 트랜잭션으로 처리하고 즉시 응답하는 절차**를 보여준다.

```python
# backend/knowledge/documents/service.py — HTTP 요청 내 원문 보관 및 작업 대기열 등록
# - body: 업로드된 파일의 원시 바이트(bytes)
# - info: 사용자가 함께 보낸 문헌 제목과 작성자·출처 메타데이터 객체(Pydantic DTO)

# 1. 파일 바이트의 SHA-256 해시와 메타데이터를 합쳐 고유 지문(fingerprint)을 계산한다.
#    같은 내용의 파일을 실수로 두 번 올렸을 때 중복 작업을 만들지 않기 위함이다.
raw_hash = hashlib.sha256(body).hexdigest()
metadata = info.metadata.model_dump(mode='json', by_alias=True, exclude_none=True)
fingerprint = metadata_digest({'raw': raw_hash, 'media': media_type, 'title': info.title, 'metadata': metadata})

# 2. 디스크에 파일을 쓰는 작업이 끝날 때까지 다른 사용자의 웹 요청이 멈추지 않도록
#    asyncio.to_thread()를 써서 별도 작업 스레드에서 원본 파일을 저장한다.
raw_path = await asyncio.to_thread(save_raw, self.settings.storage_path, body)

# 3. async with session.begin(): 블록 안의 DB 작업은 전부 성공해야 커밋되고, 오류 시 자동 롤백된다.
async with self.sessions() as session, session.begin():
    # ... 새 문헌 또는 새 판본(revision) 레코드를 생성하고, 아직 끝나지 않은 이전 대기 작업을 정리 ...
    job = await JobRepository(session).enqueue(document.id, revision.id)
    result = {
        'documentId': document.id,
        'revisionId': revision.id,      # 방금 업로드되어 대기열에 들어간 새 판본 ID
        'jobId': job.id,
        'duplicate': duplicate,         # 완전히 같은 내용·설정의 파일이 이미 등록돼 있었는지 여부
        'status': revision.index_status,
        'jobStatus': job.status,
        'shared': True,
        # 현재 검색에 활성화된 판본(active_revision_id)이 존재하고 철회되지 않았을 때만 True다.
        # 처음 올린 문헌이라면 아직 워커가 색인을 마치지 않았으므로 이 값은 False가 된다.
        'searchable': bool(document.active_revision_id and not document.withdrawn),
    }
return result
```

반환 JSON의 마지막 `'searchable'` 계산식을 보면 파일 저장이 성공했더라도 `active_revision_id`가 비어 있으면 `False`가 된다. 첫 업로드 직후에는 아직 워커가 색인을 끝내지 않았으므로 검색할 수 없지만, 이미 검색되던 문헌의 수정본을 올린 경우에는 이전 활성 판본이 남아 있으므로 `'searchable'`이 `True`로 유지된다.

DB 대기열(`processing_jobs`)에 쌓인 작업은 웹 API 서버가 아니라 별도 프로세스로 실행한 직렬 워커(`jobs/worker.py`)가 하나씩 가져가 처리한다. 이때 두 가지 운영 오류를 막기 위한 장치가 함께 동작한다.
- **워커 중복 실행 방지**: 운영자가 실수로 워커 프로세스를 두 개 띄웠을 때 둘이 똑같은 20MB PDF를 동시에 임베딩하면 API 비용이 두 배로 나가고 DB 결과도 덮어써진다. 이를 막기 위해 워커는 시작하자마자 PostgreSQL에 작업자 1명만 점유하는 세션 단위 잠금(`WORKER_LOCK = 820261029`, 권고 잠금)을 먼저 걸어, 두 번째 워커가 동시에 작업을 가져가지 못하게 차단한다.
- **비정상 종료 복구(`recover_interrupted`)**: 만약 문서 색인 도중 전원이 꺼지거나 프로세스가 강제 종료되면 DB에는 여전히 `'진행 중(running)'` 상태인 미완결 작업이 남는다. 다음 워커가 켜질 때 새 작업을 받기 전에 이 미완결 작업을 먼저 `'중단됨(실패)'` 또는 새 판본에 밀려난 상태로 정리해 두고, 운영자나 사용자의 명시적 재시도 요청이 들어올 때만 다시 처리한다.

### 2) 질문 접수와 재연결 가능한 SSE 스트리밍 (`POST /turns` ➔ `events`)

질문 답변 경로는 브라우저가 요청을 보낼 때 자주 일어나는 두 가지 문제를 풀어야 한다.
1. **버튼 연타·네트워크 재전송으로 인한 LLM 중복 호출**: 응답이 조금 늦을 때 사용자가 전송 버튼을 두 번 누르거나 네트워크가 요청을 재시도하면 같은 질문으로 유료 LLM이 두 번 호출된다. 이를 막기 위해 브라우저는 전송할 때마다 고유한 요청 번호(`requestId`)를 함께 보낸다. 서버는 이 `requestId`와 질문 내용 해시를 DB에 저장해 두고, 완전히 같은 요청이 다시 들어오면 새 모델을 부르지 않고 기존 실행 번호(`runId`)만 돌려준다. 반면 다른 질문을 같은 `requestId`로 보내면 `409 Conflict` 오류로 막는다.
2. **답변 스트리밍 중 새로고침·연결 끊김으로 인한 본문 손실**: DKM은 웹소켓 대신 서버에서 브라우저로 텍스트 조각을 단방향으로 흘려보내는 **SSE(Server-Sent Events)** HTTP 스트리밍 방식을 사용한다. 이때 답변 조각을 메모리에만 유지하고 흘려보내면 브라우저를 새로고침하는 순간 방금까지 나온 글자가 전부 사라진다. DKM은 각 조각에 순번(`seq`)을 매겨 DB(`answer_event_batches`)에 저장하므로 연결이 끊겨도 서버의 생성 작업은 계속 진행되며, 브라우저가 재연결할 때 마지막 수신 번호를 넘겨 그 이후 조각만 이어받을 수 있다.

여기서 **토큰이 나올 때마다 DB에 매번 기록하면 쓰기 부하가 심해지지 않을까** 하는 의문이 든다. 만약 LLM 토큰이 1개 도착할 때마다 PostgreSQL에 `INSERT`나 `UPDATE`를 실행하면, 여러 직원이 동시에 질문할 때 DB 쓰기 부하가 급격히 늘어난다. 이를 피하기 위해 실행기(`backend/knowledge/answers/execution.py`)는 도착한 답변 조각들을 먼저 서버 메모리 버퍼(`runtime.pending`)에 모아 둔다. 그다음 **누적된 글자가 512자(`stream_flush_characters = 512`)를 넘거나 마지막 저장 뒤 0.4초(`stream_flush_seconds = 0.4`)가 지났을 때만** 묶음 행(`AnswerEventBatch`) 1건으로 한꺼번에 DB에 커밋한다. 이 배치 전략 덕분에 토큰마다 DB를 호출하지 않으면서도 새로고침 시 최대 0.4초 이내 지점까지 안전하게 복원할 수 있다. 다만 이 구조 역시 단일 API 프로세스 기준의 사내 MVP 규모를 가정한 설계이므로, 동시 스트리밍 사용자가 더 큰 규모로 늘어나면 PostgreSQL 대신 Redis Streams 같은 전용 인메모리 버퍼로 이관하는 확장이 필요하다.

아래 라우터 코드는 질문 접수와 커서 기반 SSE 스트리밍이 실제로 어떻게 연결되는지 보여준다.

```python
# backend/knowledge/answers/router.py — 질문 실행 접수(202)와 커서 기반 SSE 스트리밍
# - body: 사용자가 입력한 질문 문자열과 브라우저가 만든 고유 requestId가 담긴 요청 객체(TurnRequest)
# - request: FastAPI 요청 객체 (create_app에서 조립한 services가 request.app.state에 들어 있다)
# - principal: 요청 헤더의 로그인 토큰을 검증해 뽑아낸 현재 사용자 객체(Depends가 자동 주입)

@router.post('/conversations/{conversation_id}/turns', status_code=202)
async def create_turn(conversation_id: str, body: TurnRequest, request: Request, principal=Depends(current_principal)):
    # 1. 질문 메시지 저장, 빈 답변 생성, requestId 중복 검사를 한 DB 트랜잭션으로 끝내고
    #    백그라운드 LLM 호출을 시작한 뒤 실행 번호(runId)를 202로 즉시 반환한다.
    return await request.app.state.services.answers.create(
        principal, AnswerRequest(conversation_id=conversation_id, **body.model_dump())
    )

@router.get('/answer-runs/{run_id}/events')
async def events(
    run_id: str,
    request: Request,
    after: int = Query(0, ge=0),              # URL 쿼리(?after=4)로 전달받은 마지막 수신 번호
    last_event_id: str | None = Header(None), # 브라우저 SSE가 재연결 시 자동으로 실어 보내는 Last-Event-ID 헤더
    principal=Depends(current_principal),
):
    # 2. 재연결 시 after 쿼리와 Last-Event-ID 헤더 중 더 큰 번호 이후부터만 이어서 전달한다.
    if last_event_id is not None:
        # 정수가 아닌 문자나 12자리를 넘는 비정상 커서 입력을 DB 조회 전에 조기 차단한다.
        if not last_event_id.isascii() or not last_event_id.isdecimal() or len(last_event_id) > 12:
            raise AppError(422, 'invalid_event_cursor', 'Last-Event-ID는 저장된 이벤트의 정수 번호여야 합니다.')
        after = max(after, int(last_event_id))

    # 3. DB에 512자 또는 0.4초 단위로 커밋된 이벤트 배치를 순서대로 스트리밍한다:
    #    진행 상태(state) -> 인용 출처(citation) -> 답변 조각(delta) -> 완료(complete) 또는 오류(error)
    ...
```

이 흐름에서 중요한 완료 경계는 마지막 이벤트의 공개 시점이다. 답변이 모두 생성되었다는 `complete` 이벤트는 LLM의 마지막 토큰이 도착하자마자가 아니라, 완성된 본문과 마지막 이벤트 배치가 **PostgreSQL에 완전히 커밋된 뒤에만** 클라이언트로 내보낸다. 덕분에 완료 신호를 받은 뒤 곧바로 페이지를 새로고침해도 DB에서 방금 끝난 답변을 빠짐없이 다시 읽어올 수 있다.

---

## 4. 단계별 오류 진단 기준

파이프라인을 구축한 뒤 실제로 부딪히는 가장 흔한 문제는 **"원본 안내서에는 조건이 분명히 적혀 있는데, AI 답변에서는 그 조건이 빠지거나 수치가 틀린다"**는 현상이다. 겉으로 보이는 증상은 하나지만, 정보가 처음 손실된 지점에 따라 고쳐야 할 코드 계층은 완전히 다르다.

DKM에서는 데이터가 흐르는 중간 산출물을 순서대로 대조하며 원인을 세 단계로 분리해 진단한다.

| 확인된 중간 상태 | 문제가 처음 발생한 단계 | 먼저 점검할 대상과 잘못된 대응 |
|---|---|---|
| **원본에는 있는데 추출문에 없다** | 전처리 및 파싱 단계 | 원본 PDF, 표 병합, XML 태그 추출 결과를 대조한다. 답변 프롬프트를 수정해도 없는 원문이 생기지 않는다. |
| **추출문과 검색 후보에는 있는데 최종 문맥에 없다** | 검색 융합, 문맥 선택 단계 | 후보 순위, 관련 설명 연결 누락, 24,000자 문맥 예산 초과 여부를 확인한다. 같은 파일을 재업로드해도 해결되지 않는다. |
| **최종 문맥에 정확히 있는데 답변이 틀리다** | 모델 해석, 프롬프트 정책, 인용 연결 단계 | 모델에 전달된 직렬화 텍스트, 답변 지시문, 각주 번호 연결을 대조한다. 검색 후보 개수만 늘리면 노이즈만 커진다. |

예를 들어 시험 안내서 표에 `"85도 기준 60.8%"`라고 적혀 있는데 챗봇이 온도 조건을 빠뜨리고 `"60.8%"`만 답했다면, 먼저 추출 결과(`passages`)에 `"85도"` 문구가 남아 있는지 본다. 추출 단계부터 빠져 있다면 3편에서 다룰 표 구조 보존 파싱을 고쳐야 한다. 반대로 검색 후보 목록에는 `"85도"` 설명 구간이 들어 있는데 LLM에게 넘긴 최종 문맥 목록에서 탈락했다면, 4편에서 다룰 문맥 예산과 의존성 묶음 선택 로직을 점검해야 한다. 마지막으로 최종 문맥까지 `"85도"`가 정확히 들어갔는데도 모델이 임의로 수치를 바꾸거나 조건을 누락했다면 6편에서 다룰 답변 프롬프트와 인용 정책을 수정해야 한다.

이처럼 원인이 발생한 단계를 먼저 좁혀야 2장에서 `create_app()`으로 분리해 둔 가짜 모델(`fixture`) 계약 테스트로 시스템 로직 결함(예산 절삭, 상태 전이, 커서 복원)을 검사할지, 아니면 실제 임베딩과 LLM을 호출해 모델 해석 능력을 평가할지 정확히 구분할 수 있다.

---

## 5. 시리즈에서 해결할 난제들

1편에서 정리한 5계층 구조와 비동기 파이프라인은 시작 기준선이다. 실제 사내 문헌과 시험 CSV를 투입해 `v1.8.14`까지 발전시키는 과정에서는 각 단계마다 뚜렷한 병목과 까다로운 요구사항이 드러났다. 이어지는 2편부터 8편에서는 1편에서 짚은 파이프라인 순서대로 각 문제를 어떻게 진단하고 해결했는지 다룬다.

1. **2편 (비동기 색인과 판본 동시성)**: 임베딩 도중 수정본이 연달아 올라오거나 CPU 대량 색인이 중단될 때, 현재 검색 중인 판본을 내리지 않으면서 뒤처진 작업만 중단하고 DB 트랜잭션 경계와 배치 중간 저장으로 상태를 지키는 방법.
2. **3편 (구조 보존 문서 전처리)**: 일반 텍스트 분할 때문에 PDF 표의 수치와 단위·캡션이 떨어져 나가거나, 목록의 원래 순번이 깨지고, XML 수식이 유실되는 문제를 구조 연결 메타데이터와 4조건 분리 실험으로 해결하는 과정.
3. **4편 (하이브리드 검색 융합과 예산 조립)**: 점수 범위가 서로 다른 키워드 검색과 벡터 검색 후보를 공정하게 합치는 순위 융합 로직과, 본문에 반드시 따라붙어야 하는 설명 구간을 묶어 24,000자 제한 안에 담는 문맥 선택 알고리즘 및 단위 테스트 계약.
4. **5편 (로컬 모델 검증과 무중단 전환)**: 경량 로컬 모델과 한국어 임베딩, 리랭커를 실험 수치로 객관적으로 평가해 채택·보류를 가르는 기준과, 기존 1,536차원 DB 스키마를 깨뜨리지 않고 1,024차원 벡터를 `0`-패딩으로 무중단 전환한 수학적·운영적 전략.
5. **6편 (실전 질의와 답변·인용 제어)**: 동음이의어 약어를 구분하는 단어사전 엔티티 링킹, 한 질문에 여러 요구가 섞인 복합 질문의 근거 누락 방어, 그리고 사용자가 대화 중 측정 조건을 직접 정정했을 때 기존 근거와 다중 출처 인용을 끝까지 지키는 정책.
6. **7편 (정형 CSV 계산과 의미 모델 온톨로지)**: 문장 검색 기반 RAG가 CSV 합격률의 분모와 분자, 재시험 규칙 계산에 실패하는 이유와, 파서 코드를 매번 수정하지 않기 위해 사람이 DB에 정의하는 의미 모델과 컬럼 매핑 온톨로지 설계.
7. **8편 (안전한 Python 계산 위임과 멀티턴 상태)**: LLM에게 임의의 Python 코드를 직접 짜서 실행하게 두는 위험을 피하면서, 검증된 조건 인자만 기존 계산 함수에 넘겨 실행하고 짧은 후속 질문에서도 계산 조건을 이어 가는 멀티턴 상태 관리.
