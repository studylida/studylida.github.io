---
title: "DKM 아키텍처 4편: 하이브리드 후보 융합과 예산 기반 문맥 선택"
description: "키워드 경계와 통합 순위 융합으로 후보를 확보하고, 리랭커 진입 전 코드 연결과 24,000자 묶음 예산 선택, 파일명 검색 회귀 교정까지 검색 파이프라인 전 과정을 정리한다."
pubDate: "2026-11-19 08:30:00"
tags: ["DKM", "RAG", "HybridSearch", "RRF", "Reranking", "Python"]
categories: ["Architecture", "Backend"]
draft: false
---

3편에서는 PDF 표의 병합 셀, 긴 수치열, 일반 XML의 상위 태그를 손실 없이 잘라 DB에 저장하는 전처리 규칙을 살펴보았다. 하지만 전처리를 마쳤는데도 6종 PDF 평가(12문항)에서는 정답 표가 후보 **9위\~31위**로 밀려났다. 그 결과 원문을 열지 않고 바로 참고 가능한 답변 비율은 `6/12`에서 `5/12`로 오히려 줄어들었다.

즉, 잘 잘라서 저장하는 것만으로는 답변 품질이 보장되지 않는다. 이제 다음 질문을 풀어야 한다. **이미 DB에 저장된 조각들을 질문 시점에 어떻게 빠뜨리지 않고 찾고, 정밀 채점 후보에 보존하며, 24,000자 예산 안에 담아낼 수 있을까?** DKM(`v1.1.5` \~ `v1.8.11`)의 검색 엔진 계층(`rag/`)이 처리하는 네 단계를 코드 실행 순서대로 따라간다.

---

## 1. 키워드 경계와 순위 융합

질문이 들어오면 DKM은 두 가지 경로로 1차 검색을 수행한다. 단어 일치를 찾는 **키워드 검색**과 문장의 의미 유사도를 계산하는 **벡터 검색**이다.

키워드 검색부터 단순한 부분 문자열 검사(`'pi' in text`)에 기대면 문제가 생긴다. 예를 들어 보드 이름인 `Pi`를 찾으려는데 `SPICE`나 `pipeline` 같은 관련 없는 영어 단어까지 오탐된다. 반대로 엄격한 영어 단어 경계만 고집하면 한국어 조사가 붙은 `Pi와`나 `Pi를`을 놓친다. DKM은 영문자, 숫자, 밑줄이 포함된 검색어를 찾을 때 앞뒤에 영문자나 숫자가 이어지는 경우만 차단하고 한글 조사는 허용한다. 덕분에 `Pi와`, `Pi-series`는 찾으면서 `SPICE`, `pipeline` 오탐은 걸러낸다.

또한 키워드 검색은 속도와 잡음 억제를 위해 질문에서 핵심 단어를 **최대 16개까지만** 뽑아 사용한다. 이때 `알려주세요`, `해주세요` 같은 요청 문구를 빼지 않으면 불필요한 말이 16칸을 차지해 진짜 기술 용어가 잘려 나간다. 그래서 DKM은 요청 문구 집합을 미리 제외해 핵심 키워드 자리를 지킨다.

두 경로에서 후보를 뽑은 뒤에는 점수를 하나로 합쳐야 한다. 그런데 키워드 점수(예: `30`)와 벡터 코사인 거리(예: `0.20`)는 단위 자체가 다르다. 두 숫자를 그대로 더하면 스케일이 큰 키워드 점수가 결과를 지배한다. 그래서 각 검색 결과의 **순위(`rank`)**를 `1 / (60 + rank)`로 바꾸어 더하는 상호 순위 융합(RRF, 여기서 `60`은 순위 차이를 완만하게 줄이는 상수)을 사용한다.

초기 DKM에는 여기서 두 가지 함정이 더 있었다. 먼저 앞단계 DB 조회는 문헌과 위키의 순위를 **각각 따로** 매겨 합산했고, 그 점수(`hit['score']`)에 사전 이름이나 작성자 일치 가산점을 함께 담아 넘겼다. 같은 질문에서 관련 문헌의 코사인 거리는 `0.20`이고 무관한 위키의 코사인 거리는 `0.70`인데도, 위키 내부 1위가 문헌 1위와 똑같은 높은 가산점을 받았다. 또한 키워드 일치 수가 같은 동점 문서 여러 개를 모두 공동 1위로 처리하면, 그 뒤를 잇는 진짜 핵심 표가 상위 60위 밖으로 밀려났다.

통합 순위 융합 함수인 `fuse_candidates()`는 세 가지 규칙으로 이를 고친다.

1. **자료 종류 통합 순위**: 문헌과 위키를 나누지 않고 전체 후보 목록을 대상으로 코사인 거리(오름차순)와 키워드 점수(내림차순) 순위를 다시 매긴다.
2. **동점은 평균 순위**: 점수 동점자가 1위\~3위까지 3건이면 모두 1위가 아니라 평균 순위인 `2.0위`를 주고, 다음 문서는 `4위`부터 시작한다. 동점 3건에 모두 1위 점수(`1/61`)를 주면 동점 문서들의 점수가 부풀려져 진짜 상위권 문서를 밀어내기 때문이다.
3. **단일 경로 꼬리 순위**: 한쪽 경로에서만 찾힌 후보를 `0점`으로 치면, 두 경로에 걸쳐 어중간하게 걸린 후보가 단일 경로 1위 후보를 추월할 수 있다. 따라서 미검출 경로에는 해당 목록 마지막 다음 순위(`size + 1`)를 공통 기준선으로 부여해 역전을 막는다. 또한 기존 점수(`hit['score']`)에서 이전 자료별 RRF 항만 빼고 통합 RRF 점수를 더하므로, 앞서 붙은 사전 이름과 작성자 가산점은 그대로 유지된다.

```python
# backend/knowledge/rag/ranking.py — 자료 종류 통합 순위, 동점 평균, 단일 경로 꼬리 순위 기반 RRF 융합
# - hits:       앞단계 검색에서 반환한 문헌·위키 후보 딕셔너리 목록 (기존 score, methodRanks 포함)
# - rank_score: 1 / (60 + rank)를 계산하는 DKM 내부 순위 점수 도우미

def fuse_candidates(hits):
    ranks, sizes = {}, {}
    for method, field, descending in [('vector', 'cosineDistance', False), ('lexical', 'lexicalScore', True)]:
        # 동점 시 순서가 흔들리지 않도록 passageId를 보조 정렬 키로 고정해 재현성을 확보한다.
        ordered = sorted((h for h in hits if field in h),
                         key=lambda h: ((-1 if descending else 1) * h[field], h['passageId']))
        sizes[method], offset = len(ordered), 0
        # groupby는 인접한 같은 점수를 한 묶음으로 묶는다. 동점 구간에 1위를 남발하지 않고 평균 순위를 계산한다.
        for _, tied in groupby(ordered, key=lambda h: h[field]):
            tied = list(tied)
            rank = offset + (len(tied) + 1) / 2
            for hit in tied:
                ranks.setdefault(hit['passageId'], {})[method] = rank
            offset += len(tied)

    result = []
    for hit in hits:
        old = hit.get('methodRanks', {})
        shared = ranks.get(hit['passageId'], {})
        # 기존 점수에서 이전 자료별 RRF 항(old)만 빼내면, 사전 이름과 작성자 가산점은 그대로 보존된다.
        score = hit.get('score', 0) - sum(rank_score(old[m]) for m in shared if m in old)
        # 미검출 경로는 0점이 아니라 해당 경로 총 후보 수 다음(size + 1) 순위를 주어야 단일 경로 핵심 근거가 밀리지 않는다.
        score += sum(rank_score(shared.get(method, size + 1)) for method, size in sizes.items() if size)
        result.append({**hit, 'score': score, 'fusionMethodRanks': shared})
    return sorted(result, key=lambda h: (-h['score'], h['passageId']))
```

22개 질문의 고정 필수 원문 49곳(장치 안내서, 센서 데이터시트 등 실자료 포함)을 대상으로 **동일한 60개 후보 상한**에서 네 조건을 비교한 결과는 아래와 같다.

| 비교 조건 | 상위 10 포함 | 상위 30 포함 | 후보 60 안 포함 | 최종 문맥 포함 |
|---|---:|---:|---:|---:|
| 기존 방식 | 32/49 | 42/49 | 46/49 | 45/49 |
| 키워드 경계만 개선 | 36/49 | 44/49 | 47/49 | 46/49 |
| 통합 융합만 개선 | 38/49 | 44/49 | 47/49 | 46/49 |
| **둘 결합** | **38/49** | **44/49** | **49/49** | **46/49** |

여기서 결과 범위를 정확히 구분해야 한다. 후보 60개 상한에서는 필수 원문 49곳이 46곳에서 49곳으로 모두 후보 안에 들어왔다. 리랭커를 끈 상태에서도 최종 문맥 포함이 `28/49`에서 `30/49`로 올랐다. 하지만 실제 서비스가 쓰는 **최대 200개 후보 경로**에서는 다음 장에서 볼 경로별 후보 보호(`rerank_pool()`) 덕분에 기존 방식도 49곳 대부분을 이미 후보에 담고 있었다. 그 결과 네 조건 모두 최종 문맥 포함 수가 `46/49`로 같았다. 즉, **1차 융합만 고쳐서는 200개 안에서 밀려나는 최종 문맥 탈락까지 풀리지 않는다.**

---

## 2. 리랭커 진입과 코드 연결

1차 벡터·키워드 검색은 수천 개 조각을 빠르게 훑어 수백 개 후보를 추리는 단계다. 반면 **리랭커(CrossEncoder)**는 사용자 질문과 후보 조각 하나를 한 쌍으로 묶어 모델이 함께 읽고 관련성 점수를 다시 매기는 모델이다. 정확도가 높지만 연산이 무거워 모든 조각을 다 넣을 수 없다. 그래서 DKM은 일반 검색 최대 **200개**(대화 응답 경로는 **120개**)로 리랭커 입력 후보를 제한한다.

이 200개 자리를 통합 점수 상위 200개로만 자르면 편향이 생긴다. 한 검색 경로(예: 문헌 벡터)의 비슷한 조각들이 200개를 모두 채워, 위키나 키워드 1위 후보가 풀에 들지 못하기 때문이다. `rerank_pool()`은 이를 막기 위해 후보를 `(자료 종류, 검색 경로)` 줄로 나눈다. 그다음 각 줄의 1위부터 차례대로 번갈아 하나씩 뽑아 200개를 채운다.

이때 한 가지 주의할 지점이 있다. `rerank_pool()`은 **후보를 고르는 순서**와 **함수가 돌려주는 순서**를 분리한다. 교대 추출 도중 `D`, `A`, `E`, `B` 순서로 4건이 뽑힐 수 있다. 그래도 마지막에는 원래 `hits` 목록(`[A, B, C, D, E]`)을 앞에서부터 순회하며 뽑힌 항목만 추려 **`[A, B, D, E]` 순서로 반환**한다. 교대 추출 순서대로 리스트를 뒤바꾸면, 리랭커가 실패해 1차 순위로 되돌아가야 할 때 원래 융합 점수 순서가 흐트러지기 때문이다.

또한 3편의 XML·가이드 문서에서 보았던 "설명만 검색되고 바로 아래 코드는 빠지는 문제" 역시 **리랭커에 들어가기 직전**에 해결해야 한다. 만약 본문(`"이 경고를 오류로 바꾸려면 다음 설정을 사용한다:"`)만 200개 풀에 들어 있다고 해 보자. 바로 다음(`ordinal + 1`) 설정 코드가 후보 풀에 없으면 리랭커가 아무리 정밀해도 없는 코드를 뽑아낼 수 없다.

`code_links()`는 리랭커 호출 직전에 후보 중 콜론(`:`/`：`)으로 끝나는 짧은 설명 문단을 찾는다. 그런 다음 **같은 판본(`sourceRevisionId`)이면서 바로 다음 번호(`ordinal + 1`)**인 코드 조각을 이웃에서 찾아낸다. 이때 XML 문서는 바로 위 부모 경로가 같아야 하고, 비XML 일반 문서는 비어 있지 않은 소제목 목록(`contextPassageIds`)이 서로 일치해야 한다. 제목 없는 아무 문단 두 개가 우연히 묶이는 일을 막기 위함이다. 조건이 맞으면 합산 **7,000 UTF-8 바이트** 한도 안에서 설명과 코드를 한 쌍으로 묶는다.

이후 바깥 연결 단계에서는 전체 후보가 200개를 넘지 않도록 풀 크기를 임의로 늘리지 않는다. 대신 새로 넣을 코드와 **같은 `(자료 종류, 검색 경로)` 줄의 맨 뒤에 있던 비보호 후보** 하나를 코드로 교체한다. 여기서 비보호 후보란 상위 8개 핵심 후보와 이미 연결된 설명을 뺀 일반 하위 후보다. 이때 코드 조각 안에는 설정 키나 XML 기호만 들어 있다. 코드만 단독으로 리랭커에 넘기면 사용자 질문과의 관련성 점수가 낮게 나오기 때문에, 채점 시에만 앞선 설명 문구를 임시로 붙여 점수를 매긴다. 채점이 끝나면 즉시 **원본 `text`로 되돌린다.** 3편에서 고정한 DB 원문과 오프셋 계약을 깨지 않고도 코드 누락을 복구하는 방식이다.

```python
# backend/knowledge/rag/ranking.py & documents/structure_links.py — 경로별 교대 추출 및 리랭커 전 코드 연결
# - hits:    fuse_candidates()를 통과한 전체 1차 후보 목록
# - origins: 200개 리랭커 풀 안에 들어온 후보들 (내부 explanation/role 도우미로 콜론 종결 설명과 코드 유형 판별)
# - nearby:  DB에서 미리 읽어 온 같은 판본의 인접 구간 목록

def rerank_pool(hits, limit=200):
    if len(hits) <= limit:
        return hits
    streams, selected = {}, {}
    for position, hit in enumerate(hits):
        ranks = hit.get('methodRanks') or {'fusion': position + 1}
        kind = hit.get('sourceKind', 'document')
        for method, rank in ranks.items():
            streams.setdefault((kind, method), []).append((rank, position, hit))

    # 각 (자료 종류, 검색 경로) 줄을 순위순으로 세운 뒤, zip_longest로 한 칸씩 번갈아 200개를 채운다.
    ordered = [[entry[2] for entry in sorted(streams[key], key=lambda e: e[:2])] for key in sorted(streams)]
    for row in zip_longest(*ordered):
        for hit in row:
            if hit is not None and len(selected) < limit:
                selected[hit['passageId']] = True
        if len(selected) >= limit:
            break
    # 반환 시에는 교대 추출 순서가 아니라 원래 융합 결과(hits)의 상대 순서를 유지한 채 필터링한다.
    return [hit for hit in hits if hit['passageId'] in selected]


def code_links(origins, nearby):
    links = []
    for origin in origins:
        if not explanation(origin) or type(origin.get('ordinal')) is not int:
            continue
        for other in nearby:
            # 같은 판본이면서 바로 다음 번호(ordinal + 1)인 코드 블록인지 확인한다.
            if (other.get('sourceRevisionId') != origin['sourceRevisionId'] or role(other) != 'code'
                    or other.get('ordinal') != origin['ordinal'] + 1):
                continue
            if origin.get('structureKind') == 'xml':
                # XML은 rsplit('/*[', 1)[0]로 자기 태그를 뗀 바로 위 부모 XPath가 같은지 비교한다.
                same_parent = (origin['structurePath'].rsplit('/*[', 1)[0] == other.get('structurePath', '').rsplit('/*[', 1)[0])
            else:
                # 비XML 문서는 빈 리스트([] == [])끼리 우연히 묶이지 않게 비어 있지 않은 소제목 ID 일치를 요구한다.
                same_parent = bool(origin.get('contextPassageIds')) and origin['contextPassageIds'] == other.get('contextPassageIds')
            if same_parent and len((origin['text'] + other['text']).encode('utf-8')) <= 7000:
                links.append((origin, other))
    return links
```

실제 XML 검색 평가에서도 `code_links()`를 켜면 1차 후보 풀에 없던 최상위 연결 검사 코드가 리랭커 후보로 새로 진입해 복구됨을 확인했다.

---

## 3. 묶음 단위의 예산 선택

리랭커가 200개 후보의 순위를 다시 매기고 핵심 근거를 뽑으면, 바깥 서비스 계층이 후속 준비를 마친다. 3편에서 각 조각에 저장해 둔 `contextPassageIds`(예: `Measured 60.8%`가 가리키는 `Age 19+` 소제목)를 보고 필수 설명을 DB에서 미리 불러오는 것이다. 이제 최종 문맥 선택 함수인 `select_context()`가 **24,000자 프롬프트 예산** 안에 들어갈 조각을 확정할 차례다.

이 단계에서 `select_context()`는 DB를 새로 조회하지 않는다. 이미 전달받은 목록만 가지고 메모리 안에서 세 가지 규칙을 엄격히 실행한다.

1. **`(sourceRevisionId, passageId)` 복합 키로 같은 판본 설명만 찾는다**: 함수 시작 시 전달받은 모든 조각으로 찾기 사전(`by_id`)을 만든다. 이때 키를 `passageId` 하나가 아니라 **`(판본 ID, 조각 ID)` 튜플**로 잡는다. 본문(`core`)은 2판(`v2`)인데 목록에 1판(`v1`)의 소제목(`heading`)만 있다고 해 보자. 튜플 키를 쓰면 `by_id.get(('v2', 'heading'))`이 `None`을 반환한다. 덕분에 1판의 옛 조건을 2판 본문에 섞지 않고 해당 본문을 건너뛴다.
2. **연속된 번호(`ordinal + 1`)의 짧은 목록을 한 묶음으로 취급한다**: 설치 안내서의 같은 소제목 아래에 짧은 목록이 여러 조각으로 나뉘어 저장된 경우가 있다. 예를 들어 `ordinal = 10`(`Python 3.9+`), `11`(`Git`), `12`(`Tar`)처럼 나뉜 형태다. 이때 제목만 같다고 무조건 묶으면 `11`번이 빠졌을 때 `10`과 `12`만 이어져 중간 단계가 감춰진다. 따라서 `select_context()`는 **같은 판본, 같은 소제목, 그리고 `ordinal == 이전 + 1`인 연속 짧은 항목**만 묶는다. 2장에서 연결한 설명·코드 쌍 역시 이 단계에서 함께 쪼갤 수 없는 한 단위로 취급된다.
3. **임시 묶음(`bundle`) 검사 후 직렬화 길이 24,000자 안에 들 때만 확정한다**: 확정 목록 `selected`는 이전 단계에서 미리 고정해 둔 근거(`prefix`, 예: 대화 내 고정 출처)로 시작한다. `seen` 집합은 확정된 ID를 기억한다. 새 후보를 검토할 때는 먼저 `bundle` 리스트에 `[필수 설명..., 본문 또는 목록 묶음...]`을 임시로 담는다. 인용 번호(`C1`, `C2`, ...)는 확정 목록 길이와 임시 묶음 길이를 더해 매긴다. `core`가 소제목(`heading`)과 각주(`note`)를 함께 요구한다면, `heading`은 `C1`, `note`는 `C2`, `core`는 `C3`이 된다. 마지막으로 제목, ID, 인용 번호, JSON 따옴표까지 직렬화한 전체 글자 수를 잰다. 이 길이가 `24,000자` 이하일 때만 `selected`에 `bundle`을 합친다. 한도를 넘기면 `core`만 따로 넣지 않고 `bundle` 전체를 버린 뒤, 순위표의 다음 후보를 차례로 대입해 남은 예산에 들어가는지 확인한다.

```python
# backend/knowledge/rag/context.py — 동일 판본 검증, 연속 목록 묶음, 직렬화 예산 일괄 검사
# - hits:           리랭커를 거친 후보와 DB에서 미리 불러온 필수 설명 목록
# - max_characters: LLM에 전달할 직렬화 문맥의 최대 글자 수 상한 (서비스 호출 시 24,000자 전달)
# - prefix:         이전 단계에서 미리 확정한 보호 근거 목록 (기본값 빈 튜플)
# - preferred:      6편의 용어·사전 정의 우선 배치를 위해 먼저 검토할 조각 ID 집합 (기본값 빈 튜플)

def select_context(hits, max_characters, *, prefix=(), preferred=()):
    selected = list(prefix)
    seen = {h['passageId'] for h in selected}
    by_id = {}
    for hit in [*selected, *hits]:
        # passageId 단일 키 대신 (sourceRevisionId, passageId) 튜플을 써서 타 판본의 설명이 오인 연결되는 버그를 막는다.
        by_id.setdefault((hit['sourceRevisionId'], hit['passageId']), hit)

    # 내부 도우미 호출: list_bundles는 ordinal + 1 연속 목록·코드 쌍을 묶고, spread_term_sections는 preferred를 앞세운다.
    groups = list_bundles(hits)
    for hit in spread_term_sections(hits, preferred=preferred):
        pid = hit['passageId']
        if pid in seen or not hit.get('text', '').strip():
            continue
        members = groups.get(pid, [hit])
        context = [by_id.get((member['sourceRevisionId'], dep)) for member in members
                   for dep in member.get('contextPassageIds', [])]
        # 필수 설명이 하나라도 비어 있으면(None 또는 빈 텍스트) 본문만 단독으로 넣지 않고 건너뛴다.
        if any(h is None or not h.get('text', '').strip() for h in context):
            continue

        bundle, bundled = [], set(seen)
        for h in [*context, *members]:
            if h['passageId'] not in bundled:
                # {**h, ...}로 원본 딕셔너리 h를 오염시키지 않고 새 사본을 만들며, selected 변경 전이므로 C1, C2, C3가 정확히 매겨진다.
                bundle.append({**h, 'alias': f'C{len(selected) + len(bundle) + 1}', 'excerpt': h['text']})
                bundled.add(h['passageId'])

        # 순수 본문 길이가 아니라 제목, ID, JSON 구분자까지 직렬화(serialized_evidence 도우미)한 실제 크기를 검사한다.
        if len(serialized_evidence([*selected, *bundle])) > max_characters:
            continue
        # append(bundle)이 아니라 extend(bundle)로 묶음 안의 각 항목을 확정 목록 뒤에 평탄하게 이어 붙인다.
        selected.extend(bundle)
        seen = bundled
    return selected
```

DKM은 이 선택 규칙이 후속 변경에서 깨지지 않도록 단위 테스트(`tests/unit/test_rag_structured_context.py`)로 두 가지 경계를 고정했다. 본문 한 건만 간신히 들어갈 빠듯한 예산에서 `heading`을 빼고 `core`만 따로 넣지 않고 `core` 자체를 제외하는지 검증한다. 아울러 다른 판본의 `heading`이 들어와도 `core`에 연결하지 않되, 그 `heading`은 스스로 요구하는 필수 설명이 따로 없는 독립 후보 자체로만 허용되는지 함께 검사한다.

---

## 4. 파일명 검색과 회귀 교정

예산 기반 문맥 선택까지 갖춘 상태에서 해결해야 할 실제 누락이 하나 더 있었다. 3편의 재분할 덕분에 본문에 숫자 값만 줄지어 들어 있는 계측 파일(`res_dev2.txt`)이 색인에는 정상 등록되었다. 하지만 사용자가 `"res_dev2.txt 데이터 설명해 줘"`라고 파일명으로 물으면 여전히 후보에서 놓쳤다.

DKM은 문헌마다 세 가지 이름을 따로 둔다. 최초 등록 제목인 **원본 제목(`title`)**, 화면에서 고쳐 부르는 **목록 제목(`displayTitle`)**, 업로드한 **파일명(`filename`)**이다. `v1.1.12`에서는 파일명 검색을 풀기 위해 `filename`과 `displayTitle`을 모든 조각에 붙여 리랭커와 최종 문맥에 일괄 전달했다.

파일명 질문은 곧바로 1위로 해결되었다. 하지만 파일명을 묻지 않는 **일반 내용 질문(28개 질문, 고정 필수 원문 58곳)**에서 문제가 드러났다. 잘 찾던 필수 원문 포함 수가 **`58/58`에서 `54/58`로 떨어졌다.** 빠진 4곳 모두 1차 검색 후보에는 들어 있었다. 전처리나 벡터 문제가 아니라 2장의 리랭커와 3장의 24,000자 예산 단계에서 밀려난 회귀였다.

원인을 추적하자 서로 다른 두 가지 문제가 겹쳐 있음이 확인되었다.

### 문제 1: 같은 파일명의 반복 직렬화가 24,000자 예산을 줄였다

설치 안내서 질문 하나에서 같은 문헌의 조각 35개가 선택되었다. 그런데 아래 수정 전 예시처럼 35개마다 똑같은 `filename`과 `displayTitle`을 JSON에 반복해 적었다. 이름 문자열만 **3,255자**를 차지했다. 결국 24,000자 한도 안에서 담기는 본문 조각 수가 42개에서 35개로 줄어 필수 근거 3곳이 밀려났다.

```text
# 수정 전 (v1.1.12): 같은 판본의 조각 35개마다 파일명과 목록 제목을 반복 기록
조각 1:  {"title": "...", "filename": "guide.pdf", "displayTitle": "장치 설치 안내서", "text": "..."}
조각 2:  {"title": "...", "filename": "guide.pdf", "displayTitle": "장치 설치 안내서", "text": "..."}
... (35번 반복 ➔ 이름 문자열만 3,255자 차지 ➔ 본문 조각이 42개에서 35개로 감소)

# 수정 후 (prompt_evidence()): 같은 판본(sourceRevisionId)에서 첫 1번만 기록
조각 1:  {"title": "...", "filename": "guide.pdf", "displayTitle": "장치 설치 안내서", "text": "..."}
조각 2:  {"title": "...", "text": "..."}   # 같은 판본이므로 이름 생략
... (중복 제거로 3,000자 이상 확보 ➔ 밀렸던 필수 근거 3곳이 예산 안으로 복귀)
```

이를 풀기 위해 최종 JSON을 조립하는 `prompt_evidence()`를 고쳤다. 먼저 허용 목록(`fields`)의 키만 남겨 내부 검색 점수가 프롬프트에 섞이지 않게 거른다. 그다음 이미 이름을 기록한 판본 집합(`named`)을 둔다. 같은 `sourceRevisionId`의 `filename`과 `displayTitle`은 **판본당 처음 1번만** 직렬화하고 이후 조각에서는 생략한다. 또 `displayTitle`이 원본 `title`과 같으면 중복이므로 아예 넣지 않는다. 이 수정만으로 `54/58`이 `57/58`로 회복되었다.

### 문제 2: 일반 질문의 리랭커 채점까지 파일명 문자열이 순위를 바꿨다

예산을 확보했는데도 1곳이 여전히 빠졌다. 왜 리랭커 입력 문장에 `filename`과 `displayTitle`을 넣었다고 일반 질문의 순위가 바뀌었을까? 두 질문을 나란히 놓아 보면 차이가 분명하다.

- **파일명 질문 (`"res_dev2.txt 데이터 설명해 줘"`)**: 본문에는 숫자(`0.125`, `0.250`)만 적혀 있다. 따라서 리랭커 입력 앞에 `res_dev2.txt`를 붙여 주어야 질문과 후보가 맞물려 1위로 올라간다.
- **일반 내용 질문 (`"리눅스에서 설치에 필요한 패키지가 뭐야?"`)**: 질문에 파일명이나 문서 이름이 전혀 없다. 그런데도 200개 후보 텍스트 앞머리마다 질문과 무관한 영어 파일명과 목록 제목을 붙였다. 그 바람에 실제 설치 패키지 구간과 목차, 개요 구간의 **상대 점수 순서가 미세하게 뒤바뀌며** 마지막 필수 근거 1곳이 예산 밖으로 밀려났다.

DKM은 리랭커 입력을 조립하기 전에 조건 하나를 추가했다. 질문 안에 이 후보의 전체 `filename` 또는 `displayTitle`이 직접 적혀 있는지 경계 검사와 함께 확인하는 것이다. 파일명이 언급된 후보에만 `원본 제목 + 파일명 + 목록 제목 + 위치 + 본문`을 넘겼다. 일반 질문에는 기존처럼 `원본 제목 + 위치 + 본문`만 넘겨 점수 순서를 보존했다. 그 결과 **`57/58`에서 `58/58` 전량 회복**에 성공했다. 파일명 질문 역시 리랭커 1위에 올랐고 직렬화 문맥 `23,993자` 안에서 정상 인용되었다.

| 변경 단계 | 최종 문맥의 필수 원문 | 모든 필수 원문을 포함한 질문 |
|---|---:|---:|
| `1.1.11` 기준 (이름 전달 전) | 58/58 | 28/28 |
| `1.1.12` 이름 일괄 전달 | 54/58 | 27/28 |
| 판본당 이름 반복만 제거 (`prompt_evidence()`) | 57/58 | 27/28 |
| **`1.1.13` 반복 제거 + 명시적 이름 재정렬** | **58/58** | **28/28** |

```python
# backend/knowledge/rag/context.py — 허용 필드 정제 및 동일 판본 내 파일명, 목록 제목 중복 직렬화 제거
# - evidence: select_context()로 확정된 최종 근거 딕셔너리 목록

def prompt_evidence(evidence):
    # 모델에 넘길 근거 메타데이터 허용 목록(fields)만 남기고 score 등 내부 검색 진단 필드는 제거한다.
    fields = ('contentType', 'evidenceRole', 'referenceEdges', 'alias', 'passageId', 'sourceRevisionId', 'title',
              'locator', 'text', 'author', 'publisher', 'publishedAt', 'sourceType', 'documentForm', 'readScope',
              'referenceNote', 'referenceOwnerRevisionId', 'sourceKind', 'knowledgeKind', 'pageId', 'revisionNumber',
              'sourceNote', 'editorId', 'evidenceId', 'evidenceKind', 'sourceRevisionIds', 'modelRevisionIds',
              'mappingRevisionIds', 'storedEvidence', 'decisionContext', 'selectionState', 'registeredMappings')
    records, named = [], set()
    for hit in evidence:
        # 딕셔너리 컴프리헨션과 `if key in hit` 조건으로 존재하는 허용 키만 추려낸다.
        record = {key: hit[key] for key in fields if key in hit}
        # 판본 ID가 없는 합성 항목에 대비해 passageId를 대체 식별자로 사용한다.
        source = hit.get('sourceRevisionId') or hit.get('passageId')
        if source not in named:
            # 같은 판본 조각 35개마다 파일명을 반복하면 3,000자 이상 낭비되므로, 판본당 처음 1회만 이름 필드를 담는다.
            for key in ('displayTitle', 'filename'):
                if hit.get(key) and (key != 'displayTitle' or hit[key] != hit.get('title')):
                    record[key] = hit[key]
            # 파일명이 없는 고정 참조, 합성 조각이 먼저 나와도 뒤 조각의 파일명이 누락되지 않게 실제 기록 시에만 named에 추가한다.
            if any(key in record for key in ('displayTitle', 'filename')):
                named.add(source)
        records.append(record)
    return records
```

---

지금까지 1\~2장의 **후보 진입 단계(융합, 경로별 풀 보존, 코드 연결)**와 3\~4장의 **선택·직렬화 단계(묶음 예산, 판본 분리, 메타데이터 중복 제거)**를 순서대로 살펴보았다. 두 단계를 분리해 검증해야만 파일명 검색 같은 새 개선이 기존 일반 질문의 예산을 잠식하거나 리랭커 순위를 흔드는 회귀를 조기에 막을 수 있다.

이렇게 검색 융합과 예산 선택 규칙을 고정하고 나면, 남은 병목은 검색 로직 바깥의 **임베딩 모델과 리랭커 모델 자체**로 좁혀진다. 외부 API 임베딩의 반복 비용과 한영 혼용 검색 한계, 로컬 리랭커의 응답 지연 문제는 5편에서 다룬다. 실제 평가로 어떻게 검증하고 무중단으로 전환했는지 이어서 살펴본다.
