---
title: "DKM 아키텍처 2편: 비동기 문서 색인과 판본 동시성 제어"
description: "사내 문헌의 수정과 재처리가 겹칠 때 기존 검색 서비스를 중단하지 않으면서 구버전 작업을 안전하게 멈추는 판본 분리, 행 잠금 재검증, 배치 임베딩 캐시, 원자적 활성화 구조를 정리한다."
pubDate: "2026-11-18 14:15:00"
tags: ["DKM", "RAG", "Concurrency", "PostgreSQL", "Indexing", "Python"]
categories: ["Architecture", "Backend"]
draft: false
---

1편에서는 웹 API가 문헌을 접수(`202 Accepted`)해 작업 대기열에 넣은 뒤, 별도의 직렬 워커(`worker.py`)가 비동기로 색인을 수행하는 전체 구조를 살펴보았다. 이번 글은 워커가 대기열에서 작업 한 건을 꺼낸 직후부터, 그 문서가 실제로 검색 대상에 올라가기까지 내부에서 벌어지는 동시성 문제를 다룬다.

사내 문서는 한 번 올리고 끝나는 정적 파일이 아니다. 담당자가 오타나 수치를 고쳐 새 수정본을 올릴 수도 있고, 잘못 올린 문서를 비활성화할 수도 있다. 이때 파싱과 임베딩처럼 수십 초 이상 걸리는 작업이 겹치면 검색 공백이나 상태 오염이 발생한다. DKM(`v1.0.0` \~ `v1.8.14`)이 두 개의 판본 포인터와 짧은 트랜잭션 재검증, 배치 캐시, 원자적 교체를 조합해 이 문제를 어떻게 해결했는지 코드 순서대로 확인한다.

---

## 1. 검색 판본과 최신 판본 분리

이미 검색에 잘 쓰이던 검사 안내서의 1판(`r1`)이 등록되어 있다고 가정한다. 담당자가 내용을 고쳐 2판(`r2`)을 새로 업로드했다. 파일이 서버에 저장된 시점에는 아직 2판의 텍스트 추출과 벡터 임베딩이 끝나지 않았다.

만약 문헌 레코드(`documents` 테이블)가 판본 ID 하나만 갖는다면 두 가지 장애 중 하나를 피할 수 없다.
1. 2판을 올리자마자 판본 ID를 2판으로 바꾸면, 색인이 끝나는 몇 분 동안 이 문헌은 검색 결과에서 사라진다. 만약 2판 파싱이 실패하면 잘 쓰던 1판까지 검색할 수 없는 상태가 된다.
2. 반대로 2판 색인이 끝날 때까지 판본 ID를 1판으로 그대로 두면, 도중에 2판의 작업 상태를 조회하거나 3판이 올라왔을 때 가장 최근에 접수된 파일이 무엇인지 구분할 수 없다.

이를 분리하기 위해 `documents` 테이블은 같은 문헌에 대해 역할을 나눈 두 개의 포인터 컬럼을 둔다.

| 컬럼 이름 | 가리키는 대상 | 언제 값이 바뀌는가 |
|---|---|---|
| **`current_revision_id`** | 가장 최근에 업로드된 판본 | 사용자가 새 수정본을 업로드한 즉시 새 판본 ID로 갱신된다. |
| **`active_revision_id`** | 현재 검색에 실제로 사용하는 판본 | 새 판본의 모든 구간 임베딩이 검증을 통과해 완전히 준비된 시점에만 교체된다. |

이 구분 덕분에 2판(`r2`)이 대기열에서 색인을 기다리는 동안 `current_revision_id`는 `r2`를, `active_revision_id`는 여전히 `r1`을 가리킨다. 사용자는 색인이 진행되는 동안에도 끊김 없이 `r1`의 문장으로 답변을 받는다. 만약 `r2`의 색인이 중간에 실패하더라도 `active_revision_id`가 `r1`에 남아 있으므로 서비스의 검색 품질은 영향을 받지 않는다.

---

## 2. 구버전 작업 중단과 상태 보호

두 판본을 분리해 두면 또 다른 경합 상황이 생긴다. 워커가 아직 1판이나 2판의 색인 작업을 처리하는 도중에, 사용자가 더 새로운 수정본을 올리거나 문헌을 비활성화(철회, `withdrawn = True`)한 경우다.

API 서버의 업로드 함수(`DocumentService.upload()`)는 새 판본을 등록할 때 DB에 남아 있는 이전 작업의 상태를 `'superseded'`(더 새로운 판본에 밀려 중단됨)로 바꾼다. 비활성화 함수(`DocumentService.deactivate()`) 역시 미완료 작업을 `'cancelled'`로 바꾼다. 그렇다면 왜 워커 내부에서도 작업 유효성을 검사하는 함수가 따로 필요할까?

이유는 **API 서버와 워커가 서로 다른 프로세스로 실행되기 때문**이다. API 서버가 DB 테이블의 작업 상태 값을 바꾸더라도, 이미 다른 프로세스에서 돌아가고 있는 워커의 파이썬 함수까지 외부에서 강제로 멈추지는 못한다.

시간 순서로 보면 경합이 일어나는 지점이 분명하다. 먼저 워커가 DB에서 1판 작업(`status = 'running'`)을 꺼내 외부 임베딩 API에 요청을 보내고 응답을 10\~20초 기다린다. 그사이에 사용자가 2판을 올리면, API 서버는 DB의 1판 작업 행을 `'superseded'`로 바꿔 저장하고 요청을 끝낸다. 하지만 이미 실행 중이던 워커 프로세스에는 아무런 중단 신호가 가지 않는다. 워커 안의 파이썬 변수는 여전히 1판 작업을 유효한 `'running'` 상태로 기억하고 있다. 따라서 10여 초 뒤 임베딩 응답을 받아 돌아온 워커가 DB를 다시 읽지 않고 결과를 저장하면, 이미 밀려난 1판 워커가 최신 2판 문헌의 상태를 덮어쓰게 된다.

즉, 두 쪽의 역할이 다르다. API 서버의 `upload()`와 `deactivate()`는 DB에 "이 작업은 이제 무효다"라는 표식만 먼저 남겨 두는 쪽이다. 반대로 워커는 DB에 결과를 쓰기 직전마다 DB 최신 행을 다시 읽어 `valid_work()`로 그 표식을 확인하고 스스로 실행을 멈추는 쪽이다.

`valid_work()`는 세 가지를 확인한다. 첫째, DB의 작업 상태가 `'running'`이 아니면 이미 API 서버가 중단 표식을 남긴 것이므로 즉시 중단 신호(`False`)를 반환한다. 둘째, 문헌이 철회됐거나(`withdrawn`) 그사이 더 최신 판본이 등록되어 `current_revision_id`가 바뀌었더라도 작업을 `'superseded'`로 정리하고 중단한다. 셋째, 이때 작업하던 판본이 이미 검색에 쓰이던 `active_revision_id`와 같다면, 뒤처진 재처리 작업만 멈출 뿐 검색 판본의 상태(`'ready'`)는 건드리지 않는다. 또한 이 함수는 직접 실행을 끊지 않고 불리언 값만 돌려주므로, 호출자인 `process_index_job()`은 반환값이 `False`일 때 즉시 함수를 빠져나와 방금 바꾼 중단 상태만 커밋하고 나머지 저장 단계를 건너뛴다.

```python
# backend/knowledge/indexing/service.py — 현재 작업이 여전히 유효한지 판정하는 방어 함수
# - document: DB에서 최신 상태로 다시 읽은 문헌 레코드 (active_revision_id, current_revision_id, withdrawn 보유)
# - revision: 지금 워커가 파싱·임베딩을 처리 중인 대상 판본 레코드
# - job:      작업 대기열(processing_jobs)의 실행 상태 레코드 (source_revision_id로 판본을 가리킴)

def valid_work(document, revision, job):
    # 1. API의 새 업로드(superseded)나 비활성화(cancelled)가 DB 작업 상태를 이미 바꿨다면 중단한다.
    if job.status != 'running':
        return False

    # 2. 문헌이 철회됐거나(withdrawn), 그사이 더 최신 판본이 등록되어 current_revision_id가 바뀌었다면
    #    상태 전이 누락까지 방어하기 위해 이 작업도 superseded로 표시하고 중단한다.
    if document.withdrawn or document.current_revision_id != revision.id:
        # utcnow()는 현재 UTC 시각을 돌려주는 DKM 내부 시간 유틸이다.
        job.status, job.updated_at = 'superseded', utcnow()

        # [핵심 보호 분기] 작업이 밀려났더라도, 지금 워커가 다루던 판본이 현재 검색 중인
        # active_revision_id와 같다면 검색 판본의 index_status('ready')를 덮어쓰지 않는다.
        if revision.id != document.active_revision_id:
            revision.index_status = 'superseded'
        return False

    # 3. 위 조건을 모두 통과해야만 워커가 다음 저장 및 활성화 단계를 진행할 수 있다.
    return True
```

```python
# process_index_job() 내부 호출부 — job_id로 방금 조회·잠금한 document, revision, job을 전달한다.
if not valid_work(document, revision, job):
    # valid_work()가 False를 반환하면 `not False`는 True가 되어 이 분기 안으로 들어온다.
    # async with session.begin(): 블록 안에서의 return은 예외가 아니므로,
    # 방금 바꾼 job.status('superseded' 등)만 DB에 정상 커밋된 뒤 나머지 단계를 건너뛰고 종료한다.
    return {'jobId': job_id, 'status': job.status}
```

---

## 3. 모델 호출과 DB 잠금 분리

앞에서 보았듯 워커가 최신 DB 행을 확인하려면 행 잠금(Row Lock)을 걸고 읽어야 한다. 여기서 흔히 떠올리는 대안은 색인이 처음부터 끝날 때까지 하나의 큰 DB 트랜잭션과 잠금을 계속 유지하는 방식이다.

하지만 원본 파일을 읽어 구간으로 나누는 작업과 텍스트를 벡터로 바꾸는 외부 임베딩 호출은 수십 초에서 몇 분까지 걸린다. 모델 응답을 기다리는 동안 DB 트랜잭션과 문헌 행 잠금을 열어 두면 문제가 생긴다. 그 시간 동안 사용자가 해당 문헌을 수정하거나 새 판본을 업로드하려는 API 요청이 전부 DB 잠금 대기 상태에 묶여 웹 응답이 멈춘다. 또한 PostgreSQL 커넥션 풀 자원이 장시간 점유되어 다른 사용자의 질문 요청까지 지연된다.

그래서 `process_index_job()`의 함수 설명에는 "No DB transaction spans a model call(모델 호출을 가로지르는 DB 트랜잭션은 없다)"이라는 규칙이 명시되어 있다. 실제 실행 흐름은 세 단계를 반복한다. 먼저 짧은 트랜잭션으로 잠금과 상태를 확인한다. 그다음 트랜잭션을 닫은 상태에서 모델을 호출한다. 마지막으로 새 트랜잭션을 열어 다시 잠금을 걸고 `valid_work()`로 재검증한 뒤 결과를 저장한다.

새 트랜잭션마다 DB 행 잠금을 거는 일은 작업 대기열 담당 객체인 `JobRepository`의 `locked_work()`가 맡는다. 이 함수는 반드시 `'문헌(document) -> 작업(job) -> 판본(revision)'` 순서로 잠금을 얻는다.

왜 하필 `document`부터 시작하는 이 순서를 지켜야 할까? API 서버의 `upload()`, `deactivate()`, `reprocess()`가 모두 최상위 부모인 `document` 행을 먼저 잠근 뒤 그 문헌에 속한 `job`과 `revision`을 잠그기 때문이다. 만약 워커가 반대로 `job`을 먼저 잠근 뒤 `document` 잠금을 기다린다면 어떻게 될까? API 서버는 `document` 잠금을 얻은 채 워커가 `job`을 놓아 주기를 기다리고, 워커는 `job` 잠금을 얻은 채 API가 `document`를 놓아 주기를 기다린다. 두 트랜잭션이 서로의 잠금을 기다리며 영원히 멈추는 교착 상태(Deadlock)에 빠진다. 같은 자원을 건드리는 모든 코드가 항상 상위 `document`에서 하위 `job`, `revision` 방향으로만 잠그도록 순서를 고정해야 교착이 생기지 않는다.

그런데 `locked_work(job_id)`가 처음 전달받는 값은 `job_id`뿐이어서 어느 문헌에 속한 작업인지 아직 모른다. 그래서 1단계에서 잠금 없이 `job` 행(`snapshot`)부터 읽어 `document_id`를 확인하고, 2단계로 문헌 행을 잠그며, 3단계로 `job` 행을 잠그고(`refresh=True`), 4단계로 판본 행을 잠근다.

```python
# backend/knowledge/jobs/repository.py — 교착 상태를 막기 위한 고정 순서 행 잠금 조회
# - self:               현재 DB 세션(self.session)을 보관하는 JobRepository 인스턴스
# - job_id:             워커가 대기열에서 가져온 작업의 고유 ID
# - DocumentRepository: 문헌과 판본 행을 조회하는 DKM 저장소

async def locked_work(self, job_id):
    # 1. 잠금 없이 작업 ID로 어떤 문헌(document_id)에 속한 작업인지 먼저 확인한다.
    #    이때 self.session 메모리 안에는 방금 읽은 옛 상태의 job 객체(snapshot)가 캐싱된다.
    snapshot = await self.get(job_id)
    if snapshot is None:
        raise AppError(404, 'job_not_found', '작업을 찾을 수 없습니다.')  # AppError: DKM 공통 예외 유틸

    # 2. [고정 잠금 순서] '문헌(document) -> 작업(job) -> 판본(revision)' 순서로 FOR UPDATE 잠금을 건다.
    #    API 서버의 upload() 역시 document부터 잠그므로, 잠금 순서 역전으로 인한 교착 상태를 피한다.
    document = await DocumentRepository(self.session).get(snapshot.document_id, lock=True)

    # 3. refresh=True(SQLAlchemy의 populate_existing=True)로 세션 메모리 캐시를 DB 최신 값으로 덮어쓴다.
    job = await self.get(job_id, lock=True, refresh=True)
    # 4. 판본 행은 이 세션에서 처음 조회하므로 refresh=True 없이 잠금만 걸어도 최신 값을 읽는다.
    revision = await DocumentRepository(self.session).revision_record(job.source_revision_id, lock=True)
    return document, revision, job
```

여기서 3단계의 `refresh=True`가 왜 꼭 필요한지 짚고 넘어가자. 1단계에서 잠금 없이 `job`을 먼저 읽으면, DB 도구가 사용하는 ORM(SQLAlchemy) 세션 메모리에는 방금 읽은 옛 상태(`'running'`)의 `job` 객체가 저장된다. 문제는 SQLAlchemy가 같은 세션 안에서 **이미 한 번 메모리에 올려 둔 행을 그대로 재사용하는 기본 동작(Identity Map)**에 있다. 만약 1단계 직후 2단계에서 문헌 잠금을 기다리는 짧은 순간에, API 서버가 DB의 `job` 상태를 `'superseded'`로 바꾸어 커밋했다고 가정해 보자. 3단계에서 행 잠금을 걸어 다시 조회하면 PostgreSQL은 분명 최신 상태(`'superseded'`)를 돌려준다. 하지만 `refresh=True`가 없으면 SQLAlchemy는 DB가 방금 보내 준 새 값을 무시하고, 1단계에서 메모리에 담아 두었던 옛 `'running'` 객체를 그대로 돌려줘 버린다. 결국 워커는 이미 무효가 된 작업을 유효하다고 오판한다. `refresh=True`(내부 옵션 `populate_existing=True`)는 이 재사용 규칙을 꺼서 방금 잠금을 건 DB 최신 값으로 메모리 객체를 강제 덮어쓰는 안전장치다.

또한 모델 호출을 마치고 돌아온 새 트랜잭션 안에서는 **비용 기록과 유효성 검사의 실행 순서**도 중요하다. 호출 후 트랜잭션에 들어가면 DKM은 `valid_work()`를 검사하기 전에 방금 끝난 외부 임베딩 호출 비용(`job.usage`)부터 먼저 기록한다. 외부 임베딩 API는 요청이 완료된 시점에 이미 토큰 비용이 과금되므로, 그사이 사용자가 새 판본을 올려 작업이 무효가 되었더라도 실제 발생한 지출 장부는 남겨야 하기 때문이다. 반대로 `valid_work()`를 먼저 실행해 구버전 작업이라고 판단되면 그 자리에서 함수를 반환(`return`)해 버리므로, 그 뒤에 적힌 비용 기록 코드는 실행조차 되지 못한 채 누락된다. 파이썬 트랜잭션 블록(`async with session.begin():`) 안에서는 예외가 아닌 정상 `return`으로 함수를 빠져나갈 때도 변경 사항이 정상 커밋된다. 덕분에 비용을 먼저 기록하고 뒤이어 `valid_work()`에서 조기 종료하면, 실제로 쓴 호출 비용과 `'superseded'` 상태만 정확히 커밋되고 구버전 벡터 저장과 판본 교체는 깔끔하게 차단된다.

```python
# backend/knowledge/indexing/service.py — 임베딩 API 호출 직후 새 트랜잭션 내부
async with sessions() as session, session.begin():
    document, revision, job = await JobRepository(session).locked_work(job_id)

    # 1. 유효성 검사보다 먼저 실제 소모한 호출 비용(usage)을 기록한다.
    #    기존 리스트를 .append()로 수정하지 않고 새 딕셔너리를 재할당해야 SQLAlchemy가 JSON 컬럼 변경을 감지한다.
    if usage is not None:
        job.usage = {'calls': [*(job.usage or {}).get('calls', []), usage]}

    # 2. 그다음 valid_work()를 검사해 구버전 작업이라면 새 벡터 저장이나 판본 교체 없이 종료한다.
    if not valid_work(document, revision, job):
        return {'jobId': job_id, 'status': job.status}
```

---

## 4. 배치 캐시와 CPU 배치 축소

지금까지 살펴본 '잠금-호출-재검증' 구조를 실제 임베딩 생성 루프에 어떻게 적용할까? 워커는 먼저 원본 문헌을 파싱해 검색용 텍스트 조각(`passages`)으로 자르고 DB에 저장한다. 그런 다음 각 조각에서 색인에 필요한 네 가지 필드(`passage_id`, `source_revision_id`, `embedding_text`, `input_hash`)만 뽑아 색인 대상 목록(`units`)으로 만든다.

긴 문서 하나에는 수십에서 수백 개의 구간이 들어간다. 만약 전부를 한 번에 임베딩 모델로 보내고 마지막에 한 번만 DB에 커밋한다면 어떻게 될까? 100개 구간 중 99개를 변환하고 마지막 100번째에서 네트워크 오류가 났을 때, 앞의 99개 벡터가 전부 유실되어 재처리 시 비용과 시간을 처음부터 다시 써야 한다.

이를 막기 위해 `process_index_job()`은 전체 구간을 `batch_size` 단위로 잘라 반복문을 돌며, 매 배치마다 3장의 세 단계를 반복해 즉시 DB에 커밋한다. 한 배치를 처리할 때는 세 저장소 객체가 역할을 나누어 협력한다.

1. **호출 전 트랜잭션**: `JobRepository.locked_work()`로 잠금을 걸고 `valid_work()`로 유효성을 확인한다. 이어 공용 벡터 캐시 담당 객체인 `EmbeddingCache`의 `lookup()` 메서드로 DB(`embedding_records`)에 이미 계산된 텍스트 해시가 있는지 먼저 조회한다.
2. **트랜잭션 밖 모델 호출**: 캐시에 없는 구간만 추려 외부 임베딩 모델에 전달해 벡터와 비용 정보(`usage`)를 받아 온다.
3. **호출 후 트랜잭션**: 다시 잠금을 얻어 비용을 먼저 기록하고 `valid_work()`를 재확인한다. 작업이 여전히 유효하면 새 벡터를 공용 캐시에 저장(`EmbeddingCache.store()`)하고, 문헌·판본 담당 객체인 `DocumentRepository`의 `bind_embeddings()`로 현재 판본의 문단 연결 테이블(`passage_embeddings`)에 연결한 뒤 바로 커밋한다.

이 캐시 구조가 안전하게 동작하려면 두 가지 조건을 더 지켜야 한다. 첫째, **모델과 차원이 다른 벡터가 섞이지 않는 것**이다. `EmbeddingCache.lookup()`은 텍스트 SHA-256 해시(`input_hash`)뿐만 아니라 모델 이름과 저장 차원을 합친 식별 문자열(`profile`, 예: `kure:KURE-v3:...:stored1536:pad0:v1`)이 모두 일치할 때만 기존 벡터를 재사용한다. 또한 DKM의 `embedding_records` 테이블은 `vector(1536)` 컬럼으로 고정되어 있으므로, 저장 전 모든 반환 벡터가 1,536차원인지와 `NaN` 같은 비정상 숫자가 없는지 함께 검사한다. (출력 차원이 더 작은 `KURE-v3` 같은 로컬 모델도 저장 규격에 맞춰 1,536차원으로 길이를 맞춰 반환하며, 그 원리는 5편에서 다룬다.)

둘째, **공용 테이블에 동시 삽입할 때 교착을 막는 것**이다. 1편에서 설명했듯 현재 문서 색인 워커는 단일 프로세스로만 실행되지만, `embedding_records`는 모든 문헌이 함께 쓰는 공용 테이블이다. `EmbeddingCache.store()`는 새 벡터를 넣을 때 해시 키를 오름차순(`sorted(vectors)`)으로 정렬해 `INSERT ... ON CONFLICT DO NOTHING`을 실행한다. 향후 다중 워커가 같은 텍스트 해시를 동시에 삽입하더라도 잠금 획득 순서가 엇갈려 교착 상태에 빠지지 않게 미리 막아 둔 방어다.

이제 앞의 배치 커밋 구조에서 자연스럽게 남는 질문 하나가 있다. **한 번에 몇 개씩 묶어(`batch_size`) 커밋해야 할까?**

묶음 크기가 클수록 DB 커밋 횟수는 줄고 GPU 병렬 처리 효율은 올라간다. 그래서 기본값과 GPU 환경에서는 `32`구간씩 묶어 처리한다. 하지만 한국어 로컬 임베딩 모델인 `KURE-v3`를 별도 로컬 추론 프로세스로 실행할 때, GPU가 없는 CPU 서버에서는 32구간을 한 번에 계산하는 데 시간이 오래 걸렸다. 그 결과 모델 호출 한 번이 180초 요청 제한 시간을 넘어 `502` 오류로 실패했다. 게다가 커밋 단위 자체가 크다 보니 중간 실패 시 아무것도 저장되지 못한 채 다시 계산해야 하는 구간 수도 많았다.

DKM(`v1.8.10`)은 이를 풀기 위해 별도의 재시도 엔진을 새로 짜지 않았다. 대신 기존 배치 커밋 루프는 그대로 둔 채, 루프 직전에 모델 공급자의 `document_batch_size` 속성(없으면 기본값 `32`)을 읽어 묶음 크기만 바꾸도록 수정했다. 아래처럼 `KureEmbeddingClient`가 CPU 환경일 때만 이 속성을 `4`로 낮추면, 같은 루프가 자동으로 4구간마다 끊어 DB에 커밋하게 된다.

```python
# backend/knowledge/integrations/kure.py — 실행 장치(CPU/GPU)에 따른 배치 크기 분기
class KureEmbeddingClient:
    def __init__(
        self,
        python_path,  # 로컬 ML 가상환경의 Python 실행 파일 경로
        model_path,   # 디스크에 내려받은 KURE-v3 모델 가중치 디렉터리 경로
        device,       # 추론을 실행할 장치 문자열 ('cpu' 또는 'cuda')
    ):
        self.python_path, self.model_path, self.device = python_path, model_path, device
        # CPU 환경에서는 180초 요청 제한 시간을 넘기지 않고 4구간마다 캐시를 커밋하도록 배치 크기를 줄인다.
        # GPU 환경('cuda')이나 별도 지정이 없는 공급자는 기존과 동일하게 32구간 배치를 유지한다.
        self.document_batch_size = 4 if device == 'cpu' else 32
```

지금까지 살펴본 세 단계 트랜잭션 반복, 캐시 재사용, 배치 크기 분기가 실제 색인 루프 안에서 어떻게 이어지는지 확인하자.

```python
# backend/knowledge/indexing/service.py — 단일 루프 안에서 캐시 조회, 모델 호출, DB 커밋을 배치마다 반복
# - sessions:         PostgreSQL 비동기 세션 팩토리
# - job_id:           현재 실행 중인 작업 ID
# - embedding_client: 사용할 임베딩 클라이언트 객체
# - units:            파싱 후 passages 테이블에서 추려 낸 IndexUnit(passage_id, input_hash 등) 목록
# - embed_uncached:   캐시에 없는 구간만 추려 모델 호출과 1,536차원 검사를 수행하는 내부 래퍼
# - utcnow:           현재 UTC 시각을 반환하는 DKM 내부 시간 유틸

phase = 'embedding'
profile = embedding_client.profile_id
embedded, reused = 0, 0  # 이번 작업에서 새로 임베딩한 구간 수와 캐시에서 재사용한 구간 수 초기화

# 테스트용 가짜 모델이나 일반 공급자 객체에는 document_batch_size 속성이 없을 수 있으므로 기본값 32를 쓴다.
batch_size = getattr(embedding_client, 'document_batch_size', 32)

for offset in range(0, len(units), batch_size):
    batch = units[offset:offset + batch_size]

    # [1. 호출 전 트랜잭션] 잠금 후 valid_work()를 확인하고, 이미 완료된 해시가 캐시에 있는지 조회한다.
    async with sessions() as session, session.begin():
        document, revision, job = await JobRepository(session).locked_work(job_id)
        if not valid_work(document, revision, job):
            return {'jobId': job_id, 'status': job.status}
        job.progress = {'phase': phase, 'processed': offset, 'total': len(units), 'embedded': embedded, 'reused': reused}
        job.updated_at = utcnow()
        # cached는 {input_hash: embedding_record_id} 형태의 딕셔너리다.
        cached = await EmbeddingCache(session).lookup(profile, [u.input_hash for u in batch])

    # [2. 트랜잭션 밖 모델 호출] cached에 없는 해시만 추려 임베딩 모델에 전달한다.
    vectors, usage = await embed_uncached(embedding_client, batch, cached)

    # [3. 호출 후 트랜잭션] 비용을 먼저 기록하고 valid_work()를 재확인한 뒤,
    # 새 벡터를 공용 캐시(embedding_records)에 저장하고 현재 판본 구간(passage_embeddings)에 연결한다.
    async with sessions() as session, session.begin():
        document, revision, job = await JobRepository(session).locked_work(job_id)
        if usage is not None:
            job.usage = {'calls': [*(job.usage or {}).get('calls', []), usage]}
        if not valid_work(document, revision, job):
            return {'jobId': job_id, 'status': job.status}
        reused += len(batch) - len(vectors)
        # 방금 저장한 새 벡터들의 DB ID도 cached에 합쳐 두어야 아래 bind_embeddings()가 전체 배치를 연결할 수 있다.
        cached.update(await EmbeddingCache(session).store(profile, vectors))
        embedded += len(vectors)
        # passage_embeddings 테이블에 (passage_id, profile_id) -> embedding_id 연결 행을 저장한다.
        await DocumentRepository(session).bind_embeddings(batch, profile, cached)
        job.progress = {
            'phase': phase,
            'processed': offset + len(batch),
            'total': len(units),
            'embedded': embedded,
            'reused': reused,
        }
        job.updated_at = utcnow()
```

이 루프 덕분에 전체 40개 구간 중 CPU 환경에서 1번 배치(4구간)만 커밋되고 2번 배치에서 오류가 나더라도, 사용자가 재처리를 요청하면 앞의 4구간은 `EmbeddingCache`에서 즉시 재사용(`reused`)되고 나머지 36구간만 모델을 호출한다.

---

## 5. 전체 구간 검증과 원자적 교체

모든 배치 반복문이 정상 종료되었다고 해서 곧바로 검색 판본을 교체하지 않는다. 활성화(`activation`) 단계에 진입한 뒤에도 마지막 안전장치가 남아 있다. 여기서 확인하려는 대상은 **구버전 판본과의 비교가 아니라, 지금 색인 중인 새 판본 자체의 누락 여부**다.

예를 들어 기존 1판은 25개 구간이었고 새 수정본 2판은 내용이 늘어나 40개 구간으로 나뉘었다고 가정하자. `len(units)`는 이미 새 2판에서 파싱한 전체 구간 수인 `40`이다. 마지막 트랜잭션 안에서도 `locked_work()`와 `valid_work()`를 다시 통과한 뒤, `DocumentRepository.embedding_count()`로 **바로 이 새 2판의 40개 문단 ID 중 임베딩 연결이 실제로 완료된 행 수**만 센다. 따라서 새 판본의 구간 수가 구버전보다 늘거나 줄더라도, 새 판본에 속한 40개 구간에 40개 벡터가 모두 연결되었다면 정상 통과한다.

반대로 40개 중 39개만 연결되고 1개가 누락된 상태로 `active_revision_id`를 바꾸면, 검색 결과에서 문헌의 일부 섹션이 빠지는 불완전한 상태가 된다. 이처럼 두 개수가 일치하지 않을 때만 409 예외(`AppError`)를 일으켜 트랜잭션을 롤백한다. 그러면 워커 최상위 예외 처리기가 별도 트랜잭션으로 작업과 판본 상태를 `'failed'`로 기록해 불완전한 판본이 검색에 올라가는 것을 막는다.

두 개수가 정확히 일치할 때만 단일 트랜잭션(`session.begin()`) 안에서 판본 준비 상태(`index_status = 'ready'`), 색인 스냅샷 ID, 문서의 활성 판본 포인터(`active_revision_id`), 작업 완료 상태(`'succeeded'`)를 한꺼번에 갱신해 커밋한다. 덕분에 절반만 적용된 중간 상태가 외부 조회 API에 노출되지 않는다.

```python
# backend/knowledge/indexing/service.py — 모든 구간 완결성 검증 후 단일 트랜잭션 내 판본 교체
phase = 'activation'
async with sessions() as session, session.begin():
    document, revision, job = await JobRepository(session).locked_work(job_id)
    if not valid_work(document, revision, job):
        return {'jobId': job_id, 'status': job.status}

    # 1. 현재 판본에 연결된 임베딩 개수가 전체 색인 대상(units) 개수와 다르면 409 예외(AppError)를 발생시킨다.
    #    AppError는 DKM 공통 예외 유틸이며, 롤백 뒤 워커 최상위 처리기가 상태를 'failed'로 기록한다.
    count = await DocumentRepository(session).embedding_count([u.passage_id for u in units], profile)
    if count != len(units):
        raise AppError(409, 'incomplete_index', '모든 유효 구간의 색인이 준비되지 않았습니다.')

    # 2. 모든 검증이 통과된 경우에만 판본 상태('ready'), 스냅샷 ID, 활성 판본 포인터, 작업 완료 상태를 함께 커밋한다.
    #    new_id('idx')와 utcnow()는 각각 'idx...' 접두사 ID와 UTC 시각을 만드는 DKM 내부 유틸이다.
    revision.index_status, revision.embedding_profile, revision.index_snapshot_id = 'ready', profile, new_id('idx')
    document.active_revision_id, document.updated_at = revision.id, utcnow()
    job.status, job.error, job.updated_at = 'succeeded', None, utcnow()

# 모든 단계가 정상 완료되면 작업 결과 요약(재사용 구간 수 reused 포함)을 반환한다.
return {'jobId': job_id, 'status': 'succeeded', 'indexedPassages': len(units), 'embedded': embedded, 'reused': reused}
```

실제 통합 테스트(`tests/foundation/test_document_pipeline.py`)의 `test_partial_embedding_cache_survives_batch_failure`는 이 전체 계약을 검증한다. 두 가지 배치 크기(`32`와 `4`) 각각에 대해 40개 구간짜리 문서를 올린 뒤, 두 번째 배치 호출에서 가짜 모델이 강제로 `502` 오류를 내도록 설정한다. 그러면 워커는 `'failed'`로 종료되고 문서 상세 조회의 `'searchable'` 값은 `False`로 유지된다. 이때 DB의 `embedding_records` 테이블을 조회하면 첫 번째 배치 분량(`32` 또는 `4`)만 정확히 남아 있다. 이어서 재처리 API(`POST /documents/{id}/reprocess`)로 실패한 작업을 다시 실행한다. 그러면 워커 반환 결과의 `reused`가 `batch_size` 이상으로 기록되며 전체 40개 구간이 완성되어 활성화된다.

---

지금까지 2편에서는 워커가 작업을 잡은 뒤 판본을 안전하게 교체하기까지의 동시성 제어와 배치 캐시 구조를 살펴보았다. 검색 대상이 안전하게 활성화되었다면, 다음 단계는 **원본 문서를 어떤 조각(`passages`)으로 나누어 넣느냐**다. 다음 3편에서는 PDF 표의 병합 셀과 단위, 목록 순번, 기술 XML 수식이 일반 텍스트 분할 과정에서 어떻게 유실되는지, 그리고 이를 보존하기 위한 전처리 구조 연결 방식을 다룬다.
