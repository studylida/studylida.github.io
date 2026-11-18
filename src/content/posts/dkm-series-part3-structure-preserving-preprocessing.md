---
title: "DKM 아키텍처 3편: 구조 보존 전처리와 안전한 재분할"
description: "PDF 표의 병합 셀과 캡션, 임베딩 한도를 넘는 긴 수치열과 Markdown 표, 일반 기술 XML을 맥락 손실 없이 자르면서도 기존 완료 데이터와 원문 위치를 보존하는 전처리 계약을 정리한다."
pubDate: "2026-11-18 16:10:00"
tags: ["DKM", "RAG", "Preprocessing", "PDF", "XML", "Python"]
categories: ["Architecture", "Backend"]
draft: false
---

2편에서는 색인 워커가 구버전 작업을 안전하게 중단하고, 배치 캐시와 원자적 교체로 검색 판본을 바꾸는 과정을 살펴보았다. 이제 다음 질문이 남는다. **원본 문서를 어떤 크기의 조각(`passages`)으로 어떻게 잘라 DB에 저장해야 검색과 답변이 망가지지 않을까?**

긴 표나 기술 XML, 수천 줄짜리 수치 파일을 단순 글자 수 기준으로 자르면 수치의 단위, 열 이름, 상위 태그가 떨어져 나간다. 반대로 빈칸이나 모호한 캡션을 임의로 추측해 채워 넣으면 원문에 없는 거짓 사실이 생긴다. DKM(`v1.0.0` \~ `v1.8.14`) 가운데 저장 전처리 계층이 PDF 표, 긴 텍스트, 일반 XML에 공통으로 적용한 구조 보존 원칙을 살펴본다. *(잘린 조각을 읽기 시점에 다시 엮는 목록 연속성과 설명-코드 연결, 그리고 검색 4조건 실험은 4편에서 이어서 다룬다.)*

---

## 1. 글자 수 분할이 깨는 문맥

문서에서 숫자 자체를 정확히 추출했다고 해서 바로 검색에 쓸 수 있는 것은 아니다. 숫자가 가리키는 대상, 단위, 조건이 같은 문맥 안에 남아 있어야 의미를 읽을 수 있다.

예를 들어 본문 문단에 `Measured 60.8%`라는 문장이 있고, 그 바로 위 소제목에 `Age 19+`(만 19세 이상 대상)라는 조건이 적혀 있다고 가정하자. 문단만 잘라 내고 소제목과의 연결을 끊어 버리면, 검색 단계에서는 누구를 측정한 60.8%인지 알 수 없다. 그래서 DKM은 본문 문단을 저장할 때 위쪽 소제목 조각의 ID를 문맥 참조(`contextPassageIds`)로 함께 기록해, 검색 시 소제목이 같이 따라오도록 만든다.

PDF 표에서는 문맥 손실이 더 직접적인 오답으로 이어진다. 표 위에 `시간 단위: ms`라는 캡션이 있고 아래 표 칸에는 `12`, `18`, `25`만 적혀 있는 경우가 대표적이다. 표의 숫자 행만 잘라 내면 밀리초(`ms`) 단위가 사라진다. 가로로 두 열을 합친 병합 셀(`colspan=2`)도 마찬가지다. 두 열이 공유하는 값이 하나만 적혀 있는데 파서가 이를 왼쪽 열에만 넣고 오른쪽 열은 빈칸으로 저장했다고 해 보자. 이후 언어 모델은 전달받은 빈칸만 보고 **"원문에 오른쪽 열의 값이 없다"고 거짓 단정을 내린다.**

그렇다고 전처리 코드가 빈칸이나 모호한 위치를 임의로 추측해 채우면 더 큰 문제가 생긴다. 원래 측정하지 않아 비워 둔 칸에 앞 행의 숫자를 복사해 넣으면 없는 수치가 만들어진다. 한 페이지에 표가 두 개 나란히 있고 캡션 하나가 둘 사이에 걸려 있을 때도 같다. 가장 먼저 찾은 첫 번째 표에 무조건 캡션을 붙여 버리면 다른 표의 단위를 잘못 연결하는 오답이 된다. 결국 전처리는 **원문에 명시된 관계만 보존하고, 모호한 관계는 추측해 채우지 않는다**는 선을 지켜야 한다.

---

## 2. 추측 없이 지키는 표 구조

PDF 표 인식을 고치기 위해 DKM은 먼저 공개 PDF 6종에 들어 있는 표 8개를 대상으로 추출 후보 3종을 비교 실험했다. 표 안에서 고유한 행 이름과 수치, 열 위치가 정확히 맞물리는 153개 항목을 얼마나 보존하는지 대조했다.

| 후보 엔진 | 대상 표 탐지 | 수치·위치 보존 (153개 기준) | 페이지당 처리 시간 중앙값 | 관찰된 한계 |
|---|---:|---:|---:|---|
| **`img2table`** (CPU) | 8/8 | 75/153 | 7.05초 | 한글 카탈로그 열 이름 훼손, 지수(`10¹⁸`) 평탄화(`1018`) |
| **`gmft`** (CPU) | 6/8 | 91/153 | 0.48초 | 다단 페이지 작은 비교표와 오래된 스캔 미탐지 |
| **`PaddleOCR-VL`** (GPU) | 8/8 | 148/153 | 32.73초 | Attention 논문 공유 셀(`colspan=2`)을 단일 칸으로 축소·누락 |

실험 결론은 분명했다. **어느 단일 엔진도 탐지, 한글 인식, 병합 구조, 속도를 한꺼번에 만족시키지 못한다.** 가장 높은 수치 보존율(`148/153`)을 보인 `PaddleOCR-VL`조차 논문 표의 가로 병합 셀(`colspan=2`)을 한 칸으로 합쳐 버렸다. 그 결과를 읽은 LLM은 두 번째 열(`EN-FR`)의 학습 비용이 원문에 없다고 오답을 냈다. 반면 수치 보존이 낮았던 `img2table`은 추출한 HTML 표 태그(`<table>`) 안에 원본 PDF 표와 동일한 `colspan=2` 속성을 그대로 출력했다.

DKM은 세 엔진 모두 인식한 표를 HTML `<table>` 형식으로 반환한다는 점에 주목했다. 이에 따라 수치 인식 품질이 가장 높았던 `PaddleOCR-VL`을 선택형 파서로 연결하되, 단일 엔진 결과에만 의존하지 않도록 표 정규화 함수 `prepare_tables()` 안에 세 가지 변환 규칙을 두었다.

1. **명시된 병합 셀(`rowspan`, `colspan`)만 펼친다**: 추출된 HTML 표 태그에 세로 병합(`rowspan`)이나 가로 병합(`colspan`) 속성이 적혀 있을 때만 그 칸 수만큼 값을 복제해 채운다. 파서가 병합 속성을 놓쳐 비어 있는 칸은 주변 값으로 추측해 채우지 않는다. 만약 행·열 범위가 표 크기를 벗어나거나 셀 위치가 서로 겹치는 깨진 표가 들어오면, 문헌 전체를 실패시키는 대신 해당 표만 건너뛰고 정상 본문과 다른 표의 색인은 그대로 진행한다.
2. **소속이 분명한 캡션과 단위만 연결한다**: 표 주변의 제목이나 단위(`단위: ms`), 각주 블록은 표와 가로로 절반(50%) 이상 겹치고, 세로 간격이 페이지 높이의 10% 이내로 가까우며, 둘 사이에 다른 본문이 끼어 있지 않을 때만 후보가 된다. 이 조건을 만족하는 가장 가까운 표가 단 하나뿐일 때만 캡션을 그 표에 붙인다. 두 표 사이에 비슷한 거리로 걸려 있어 어느 표의 설명인지 단정할 수 없을 때는 억지로 한쪽에 붙이지 않고, 캡션을 독립된 일반 문단 조각으로 저장해 원문 정보만 보존한다.
3. **큰 표를 여러 조각으로 나눌 때는 맨 위 열 제목 줄을 반복해 붙인다**: 임베딩 모델에는 입력 길이 제한이 있어, DKM 색인 워커는 임베딩 텍스트(`embedding_text`)가 UTF-8 **7,000바이트**를 넘으면 그 조각을 색인에서 제외한다. 만약 100행짜리 큰 표를 1\~30행 조각과 31\~60행 조각으로 나누면서 31\~60행에 숫자만 남기면, 두 번째 조각만 검색되었을 때 각 숫자가 무슨 열인지 알 수 없다. 그래서 `prepare_tables()`는 문서 제목과 절 위치, 반복할 열 제목 줄까지 모두 합쳐 **6,000바이트** 안에 들어오도록 행을 끊고, 두 번째 조각부터는 표 맨 위의 열 제목 줄을 앞에 다시 복사해 붙인다. 이때 HTML 표에 열 제목 태그(`<th>`)가 명시되어 있으면 그 상단 제목 행들을 복사한다. 반대로 OCR 엔진이 `<th>` 구분 없이 일반 셀(`<td>`)로만 표를 뽑았으면 표의 맨 위 3줄을 대신 복사해 열 구분 참고용으로 붙인다.

```python
# backend/knowledge/documents/table_preprocessing.py — prepare_tables() 내부의 헤더 반복 표 분할기
# - cells:     HTML <td>/<th>의 명시적 rowspan·colspan만 전개해 만든 TableCell 목록
# - caption:   단일 표로 귀속이 확정된 제목, 단위, 주석 문자열 (모호하면 빈 문자열)
# - locator:   '페이지 3 · 표 1' 형태의 출처 위치 문자열
# - title:     임베딩 입력 상단에 고정할 문헌 제목

def _table_chunks(cells, caption, locator, title):
    grid = _grid(cells)  # 내부 헬퍼: 명시된 rowspan·colspan 범위만 2차원 격자에 채우고 특수 문자를 이스케이프
    neutral = '| ' + ' | '.join(f'열 {c + 1}' for c in range(len(grid[0]))) + ' |'
    separator = '| ' + ' | '.join(['---'] * len(grid[0])) + ' |'
    row_text = lambda r: '| ' + ' | '.join(grid[r]) + ' |'

    headers = []
    for row in range(len(grid)):
        values = [c for c in cells if c.row <= row < c.row + c.row_span]
        # 데이터 행의 첫 칸에만 행 이름용 <th scope="row">가 쓰인 경우를 걸러 내고,
        # 표 맨 위에서 열 전체가 <th>(또는 빈칸)로만 이루어진 상단 열 제목 행들만 모은다.
        if not values or not any(c.is_header for c in values) or not all(
                not c.text or c.is_header and c.header_scope not in {'row', 'rowgroup'} for c in values):
            break
        headers.append(row)
    # OCR 엔진이 <th> 태그를 전혀 출력하지 않았다면 표의 맨 위 3줄(0, 1, 2행)을 참고용 열 헤더로 삼는다.
    context_rows = headers or list(range(min(3, len(grid))))

    def text_for(rows):
        parts = [caption] if caption else []
        # 두 번째 묶음(rows[0] > 0)부터는 위에서 찾은 열 제목 행들(context_rows)을 앞에 다시 복사해 붙인다.
        if rows[0] > 0:
            parts.append('\n'.join(['열 구분 참고 · ' + ('원문 헤더' if headers else '표의 처음 행'),
                neutral, separator, *(row_text(r) for r in context_rows)]))
        parts.append('\n'.join([f'원본 행 {rows[0] + 1}–{rows[-1] + 1}', neutral, separator,
                               *(row_text(r) for r in rows)]))
        return '\n\n'.join(parts)

    def fits(rows):
        # 한글은 UTF-8 1글자가 3바이트이므로 글자 수(len) 대신 .encode('utf-8')로 실제 바이트를 재서 6,000B 안에 맞춘다.
        embedded = f'문헌: {title}\n절: {locator} · 원본 행 {rows[0] + 1}–{rows[-1] + 1}\n{text_for(rows)}'
        return len(embedded.encode('utf-8')) <= PASSAGE_BYTES

    chunks, pending, held = [], [], []
    for row in range(len(grid)):
        if pending and not fits([*pending, row]):
            chunks.append((pending, text_for(pending)))
            pending = []
        if not fits([row]):  # 단 한 행만으로도 6,000바이트를 넘기면 무리하게 자르지 않고 보류 행으로 분리한다.
            held.append(row + 1)
            continue
        pending.append(row)
    if pending:
        chunks.append((pending, text_for(pending)))
    return chunks, context_rows, held
```

---

## 3. 추출 본문 기준의 재분할

PDF가 아닌 일반 Markdown 문서나 수백 줄짜리 텍스트 계측 파일에서도 똑같은 7,000바이트 초과 문제가 발생한다. 빈 줄 없이 이어진 전압·시간 측정치나 큰 Markdown 표를 기존 분할기가 한 덩어리로 묶으면, 7,000바이트 상한에 걸려 파일 전체가 색인에서 제외(`excluded = True`)된다.

이를 해결하기 위해 재분할 함수 `split_oversized()`도 앞의 PDF 표처럼 표나 수치열을 여러 조각으로 나누고, 각 조각 앞에 열 이름과 설명을 붙여 준다. **그런데 이미 문서 원문(`content`)이 DB에 저장되어 있는 Markdown·텍스트 파일에서는, 조각 본문(`text`) 앞에 열 이름을 직접 끼워 넣으면 화면의 출처 하이라이트 기능이 깨지는 문제가 생긴다.**

구체적인 예시로 살펴보자. DKM에서 사용자가 답변의 출처 번호(`[1]`)를 클릭하면, 화면 오른쪽에 문서 전문(`content`)이 열리면서 해당 조각의 시작 위치(`start_offset`)부터 끝 위치(`end_offset`)까지 글자를 정확히 찾아 하이라이트한다. 만약 200줄짜리 Markdown 표에서 `50~80행` 조각을 잘라 낼 때, `1~2행`에 있던 열 이름을 조각 본문(`text`) 앞에 직접 합쳐서 DB에 저장하면 어떻게 될까? 문서 전문(`content`) 안에는 `1~2행` 바로 다음에 `50~80행`이 이어지는 문자열이 존재하지 않는다. 결국 `content[start_offset:end_offset]`가 조각 본문(`text`)과 일치하지 않게 되어 원문 위치 대조와 하이라이트가 깨진다.

DKM은 모든 조각에 대해 **화면·인용용 원문 조각(`text`)**과 **임베딩 모델 입력용 문자열(`embedding_text`)**을 분리해 이 문제를 해결한다.

- **`text`와 `start_offset`/`end_offset`**: `50~80행` 원문 그대로를 한 글자도 바꾸지 않고 저장한다. 덕분에 문서 전문(`content[start_offset:end_offset] == text`)과의 위치 일치가 정확히 유지된다.
- **`embedding_text`**: 검색용 벡터를 만들 때만 쓰는 문자열이므로, 이 문자열 앞부분에만 `1~2행`의 열 이름과 앞선 설명(`설명·열 이름:`, 최대 2,000바이트)을 복제해 붙인다. *(이후 검색된 `50~80행` 조각을 LLM에 전달할 때는, 따로 저장된 `1~2행` 설명 조각을 `contextPassageIds` 참조로 함께 불러와 프롬프트에 넣어 준다.)*

`split_oversized()`는 큰 구간을 만났을 때 Markdown 열 구분선(`|---|`)이나 연속된 숫자 줄을 찾아 표·수치 영역을 식별한다. 그다음 **행 경계** 단위로만 줄을 모으되, 문맥 머리말과 합친 크기가 1,400자 또는 6,800바이트(행 번호 표기 200바이트 여유 확보)를 넘기 직전에 끊어 한 조각으로 저장한다. 반면 코드 블록이나 수식 블록, 혹은 단 한 줄이 7,000바이트를 넘는 행은 중간을 임의로 자르지 않고 보류 상태로 남긴다.

```python
# backend/knowledge/documents/text_splitting.py — split_oversized() 내부의 행 단위 묶음과 원문 오프셋 보존기
# - text:        DB에 저장된 문서 전체 본문(content)
# - locator:     현재 절 위치 문자열
# - title:       문헌 제목 문자열
# - maximum:     단일 조각의 최대 글자 수 상한 (기본값 1,400자)
# - records:     분할된 조각 딕셔너리들을 순서대로 담아 반환하는 결과 리스트
# - contexts:    표 앞의 열 제목(1~2행 등)과 뒤따르는 주석의 (시작, 끝) 오프셋 튜플 목록
# - start, stop: 이번 분할 조각을 잘라 낼 전체 본문(text) 내 시작·끝 인덱스

def append(start, stop, kind, contexts=(), *, atomic=False):
    # * 뒤의 atomic은 키워드 전용 인자다. 아래 rows()가 이미 행 단위로 묶어 넘긴 표(atomic=True)를 중간 절단하지 않게 강제한다.
    context = '\n'.join(text[a:b].strip() for a, b in contexts)
    # 멀티바이트 한글 중간이 잘려 UnicodeDecodeError가 나지 않도록 errors='ignore'로 안전하게 2,000B까지 자른다.
    context = context.encode('utf-8')[:2000].decode('utf-8', errors='ignore')
    base = f'문헌: {title}\n절: {locator}\n'
    prefix = base + (f'설명·열 이름:\n{context}\n' if context else '')
    parts, cursor = [], start
    while cursor < stop:
        limit = stop if atomic else min(stop, cursor + maximum)
        if not atomic:
            # 일반 문단은 prefix(제목+절+설명)와 합쳐 워커 상한 7,000바이트를 넘지 않을 때까지 줄인다.
            while limit > cursor and len((prefix + text[cursor:limit]).encode('utf-8')) > 7000:
                limit -= 1
        # ... 공백/줄바꿈 경계 보정 후 앞뒤 공백을 제외한 슬라이스 [a, b) 산출 ...
        raw = text[cursor:limit]
        left, right = len(raw) - len(raw.lstrip()), len(raw.rstrip())
        if right > left and any(c.isprintable() and not c.isspace() for c in raw[left:right]):
            a, b = cursor + left, cursor + right
            first_line, last_line = text.count('\n', 0, a) + 1, text.count('\n', 0, b) + 1
            where = f'{locator} · 행 {first_line}–{last_line}'
            embedded = f'문헌: {title}\n절: {where}\n' + (f'설명·열 이름:\n{context}\n' if context else '') + text[a:b]
            source = dict(startOffset=a, endOffset=b, locator=where, structureKind=kind,
                          lineRange=[first_line, last_line], contextOrdinals=[])
            # text에는 열 이름을 합치지 않은 순수 원문 슬라이스(text[a:b])만 넣어 start_offset(a)/end_offset(b) 일치를 지킨다.
            records.append(dict(text=text[a:b], start_offset=a, end_offset=b, locator=where,
                                embedding_text=embedded, source=source))
        cursor = limit

def rows(first, last, contexts):
    pending = first
    for index in range(first, last):
        a, b = span(pending, index + 1)  # 내부 헬퍼: pending행부터 index행까지의 본문 시작·끝 오프셋
        context = '\n'.join(text[x:y].strip() for x, y in contexts).encode('utf-8')[:2000].decode('utf-8', errors='ignore')
        size = len(f'문헌: {title}\n절: {locator}\n설명·열 이름:\n{context}\n{text[a:b]}'.encode('utf-8'))
        # 행 번호 꼬리표(' · 행 50–80')가 붙을 여유 200B를 남겨 6,800B(또는 1,400자) 초과 직전에 행 단위로 끊어 저장한다.
        if index > pending and (b - a > maximum or size > 6800):
            append(*span(pending, index), 'table', contexts, atomic=True)
            pending = index
    if pending < last:
        append(*span(pending, last), 'table', contexts, atomic=True)
```

그렇다면 이 분할기가 도입되기 전에 **7,000바이트 초과로 이미 실패했던 문서를 재처리(`reprocess`)할 때**는 DB에서 어떤 일이 벌어질까? `1~90행`으로 이루어진 10,000바이트짜리 표 파일을 예로 들어 `passages` 테이블에 행이 쌓이는 과정을 따라가 보자.

1. **과거 실패 시점 (예전 분할기)**: 예전 분할기는 긴 표를 쪼개는 기능이 없어서, **`1~90행` 전체(10,000바이트)를 0번 조각(`ordinal = 0`) 하나**로 DB에 넣었다. 워커는 이 0번 조각이 7,000바이트를 넘자 **색인 제외(`excluded = True`)**로 표시했고, 검색에 쓸 수 있는 정상 조각이 하나도 없어 작업이 `'failed'`로 끝났다.
2. **재처리(`reprocess`) 실행 시 (`split_oversized()` 적용)**: 이제 코드에 `split_oversized()`를 추가한 뒤 재처리를 실행한다. 새 분할기는 같은 문서 본문(`1~90행`, 10,000바이트)을 다시 읽어들여, 7,000바이트 이하가 되도록 **`1~30행`(약 3,400B), `31~60행`(약 3,300B), `61~90행`(약 3,300B)의 작은 조각 3개**로 나눈다. 이때 DKM은 과거에 왜 실패했는지 감사 이력을 남기기 위해, 예전에 실패했던 0번 행(`1~90행 전체, excluded = True`)을 `DELETE`로 지우지 않는다. 대신 0번 행은 그대로 둔 채, 방금 30행씩 새로 나눈 세 조각을 그다음 번호인 **`ordinal = 1`(`1~30행`), `ordinal = 2`(`31~60행`), `ordinal = 3`(`61~90행`)**(`excluded = False`)으로 테이블 뒤에 이어 붙인다.
3. **정상 활성화 통과**: 결과적으로 테이블에는 실패했던 옛 0번 행(`excluded = True`)과 새로 잘라 넣은 1, 2, 3번 행(`excluded = False`)이 함께 들어 있다. 하지만 워커가 임베딩 대상(`units`)을 불러올 때와 2편에서 본 `embedding_count()`로 개수를 확인할 때는 **`excluded = False`인 정상 조각(1, 2, 3번 총 3개)만 조회**한다. 덕분에 과거 0번 실패 기록을 DB에 온전히 보전하면서도, 새로 나눈 1, 2, 3번 조각만으로 임베딩과 판본 활성화를 마친다.

여기서 한 가지 현실적인 의문이 든다. **실패 이력을 남긴다면서 10,000바이트짜리 옛 0번 조각 본문을 그대로 두면 저장 공간이 낭비되지 않을까?** 실제로 이미 `document_revisions.content`에 문서 전문이 있는데, 실패한 0번 조각의 `text`와 새로 쪼갠 1, 2, 3번 조각의 `text`까지 모두 남기면 텍스트 용량이 중복되는 것은 맞다. 그럼에도 DKM이 삭제 대신 보존을 택한 데는 두 가지 현실적 경계가 있었다.

- **고비용 벡터 인덱스는 생성되지 않는다**: `excluded = True` 조각은 임베딩 단계 이전에 제외되므로, DB 용량과 메모리를 가장 많이 차지하는 1,536차원 실수 벡터(`embedding_records`)는 아예 만들어지지 않는다.
- **구버전(`v1 ➔ v2`) 실패 문헌에 한 번만 실행된다**: 이 이어 붙이기 복구는 구버전 분할기(`version == 1`)로 처리했다가 길이 초과로 멈춘 비활성 판본(실제 서비스 기준 10건)에만 딱 한 번 동작한다. 복구가 끝나면 분할기 버전이 `2`로 갱신되어 이후 재처리를 다시 눌러도 중복 행이 계속 쌓이지 않는다. 다만 대규모 문서가 상시 유입되는 일반 환경이라면, 실패 조각에는 본문 전체 대신 `(start_offset, end_offset, exclusion_reason)` 위치와 사유만 남기는 쪽이 저장 공간 면에서 더 합리적이다.

---

## 4. 일반 XML의 안전한 분할

사내 문서는 PDF와 Markdown만 있지 않다. 장비 설정 파일이나 공정 명세처럼 XML 형식으로 작성된 기술 문서도 많다. DKM에는 원래 학술 논문 표준 XML 형식(`JATS`)을 읽는 파서가 있었지만, 일반 장비·설정 XML을 넣으면 태그 구조가 달라 처리에 실패했다.

`prepare_xml()`은 먼저 루트 태그를 확인해 논문 형식(`article` 등)만 기존 파서로 보내고, 나머지 일반 XML은 직접 분할한다. 본격적인 분할에 앞서 **파이썬 XML 스트리밍 파서(`expat`)**로 보안과 크기 상한부터 검사한다. 외부 서버나 로컬 파일을 몰래 읽어 들이는 DTD 엔티티 선언(문서 내부 매크로 정의)과 외부 참조를 즉시 차단하고, 파일 크기(5 MiB), 중첩 깊이(64단계), 노드 수(50,000개), 전체 글자 수(500,000자)가 한도를 넘으면 거부한다.

상한 검사를 통과한 XML은 요소 트리로 읽은 뒤 7,000바이트 한도 안에 들어오도록 조각을 나눈다. 이때 왜 단순 자식 분할만으로는 부족한지 아래 장비 설정 XML 예시로 살펴보자.

```xml
<device name="sensor_A" mode="production">
  <channel id="1"> ... (4,000바이트 분량의 상세 설정) ... </channel>
  <channel id="2"> ... (4,000바이트 분량의 상세 설정) ... </channel>
</device>
```

전체 `<device>` 블록은 8,000바이트가 넘어 7,000바이트 한도를 초과하므로 한 조각으로 넣을 수 없다. 그래서 안쪽 자식 태그 단위로 내려가 `<channel id="1">`(4,000바이트)과 `<channel id="2">`(4,000바이트)를 각각 별도 조각으로 분리해야 한다.

**그런데 자식인 `<channel>` 두 개만 따로 떼어 저장하면 무슨 문제가 생길까?** 바깥 부모 태그에 적혀 있던 `name="sensor_A" mode="production"`이라는 장비 이름과 동작 모드 정보가 어느 조각에도 남지 않고 사라진다. 나중에 `<channel id="2">` 조각이 검색되더라도, 이게 어느 장비의 2번 채널인지 알 수 없게 된다.

이를 막기 위해 `prepare_xml()`은 자식 태그들을 쪼개기 직전에 두 단계로 부모 정보를 보존한다.

1. **부모 태그 자체를 먼저 별도 조각으로 저장한다**: 안쪽 `<channel>` 자식들을 떼어 내고, 부모의 여는 태그와 속성만 남긴 `<device name="sensor_A" mode="production" />`을 **0번 조각**으로 먼저 저장한다.
2. **자식 조각의 `embedding_text` 앞에 부모 조각을 복사해 붙인다**: 이어서 **1번 조각**(`<channel id="1">...`)과 **2번 조각**(`<channel id="2">...`)을 만들 때, 각 조각의 검색용 입력(`embedding_text`) 앞부분에 방금 저장한 0번 부모 조각의 텍스트(`상위 요소:`, 최대 2,000바이트)와 태그 계층 경로(`XPath`)를 함께 복사해 붙인다.

이 두 단계를 거치면 `<channel id="2">` 조각 하나만 단독으로 검색되더라도, 그 조각의 임베딩 텍스트 안에 `<device name="sensor_A" mode="production" />`이 함께 들어 있어 어느 장비의 설정인지 맥락을 잃지 않는다.

반면 XML 태그 안에 일반 텍스트 대신 이미지나 이진 데이터가 Base64 문자열(예: `<ByteString>`, `<base64Binary>` 태그)로 인코딩되어 들어 있는 경우에는 글자로 쪼개도 의미를 읽을 수 없다. 따라서 이런 이진 데이터 노드는 검색 대상에서 보류(`qualityHold`)한다. 만약 부모 태그 아래에 정상 설정 태그와 Base64 이진 태그가 함께 섞여 있다면, 전체 크기가 7,000바이트보다 작더라도 위와 똑같이 자식 단위로 쪼개어 이진 태그만 보류하고 나머지 정상 설정 태그는 검색되게 살린다. 이처럼 XML 구조 추출은 스키마 전체 검증이나 이진 데이터 복원을 수행하는 것이 아니므로, 결과 범위는 항상 부분 추출(`readScope = 'partial'`)로 기록한다.

```python
# backend/knowledge/documents/xml_structure.py — prepare_xml() 내부의 자식 경계 분할 및 상위 태그 연결기
# - node:    파이썬 ElementTree(ET) XML 요소 노드 (예: <device> 또는 <channel>)
# - path:    루트부터 현재 태그까지 누적한 XPath 경로 문자열
#            (문서마다 다른 네임스페이스 접두사에 영향받지 않도록 /*[local-name()='device'][1] 형식으로 태그 이름을 표기)
# - parents: 바깥 부모 태그 조각들이 content 리스트에 저장된 인덱스 번호 목록 (예: [0])
# - content: 분할된 XML 조각 문자열들을 순서대로 모으는 외부 리스트
# - size:    현재까지 content에 쌓인 전체 추출 본문의 누적 문자 길이

def emit(node, path, parents):
    nonlocal size
    # block은 순수 XML 조각(text)과 XPath·상위 부모 태그 문자열을 앞에 붙인 검색용 문자열(embedded)을 만든다.
    text, embedded = block(node, path, parents)

    # ElementTree에서 len(node)는 직계 자식 태그의 개수다.
    # 자식이 있으면서 7,000B를 넘거나, 자손 중에 Base64 이진 노드(_encoded)가 섞여 있으면 자식 단위로 쪼갠다.
    if len(node) and (len(embedded.encode('utf-8')) > 7000 or any(_encoded(child) for child in node.iter())):
        # 1단계: 안쪽 자식들을 제외한 부모 자신의 태그와 속성(예: <device name="sensor_A" />)만 먼저 0번 조각(own)으로 저장한다.
        shallow = ET.Element(node.tag, node.attrib)
        shallow.text = node.text
        own = emit(shallow, path, parents)
        counts = {}
        for child in node:
            name = _local(child.tag)  # 내부 헬퍼: 네임스페이스 접두사를 떼어낸 순수 태그 이름
            counts[name] = counts.get(name, 0) + 1
            # 2단계: 각 자식(<channel>)을 재귀 호출할 때 부모 조각 번호([*parents, own])를 넘겨 상위 요소로 붙게 한다.
            # parents.append()로 원본 리스트를 수정하면 옆 형제 노드에 값이 섞이므로 새 리스트를 만들어 전달한다.
            emit(child, path + f"/*[local-name()='{name}'][{counts[name]}]", [*parents, own])
        return own

    start = size + (2 if content else 0)  # 조각 사이 '\n\n'(2자) 구분자를 합산해 누적 추출 본문 기준 오프셋 계산
    end = start + len(text)
    # ... 이후 한도/이진 노드 보류(qualityHold) 검사 및 start_offset/end_offset 저장 뒤 content 리스트 갱신 ...
    content.append(text)
    size = end
    return len(content) - 1
```

---

## 5. 전처리 너머의 선택 문제

여기까지 적용하면 PDF 표는 병합 셀과 헤더가 유지된 채 잘린다. 7,000바이트를 넘기던 긴 수치열과 Markdown 표도 출처 하이라이트 위치(`start_offset`, `end_offset`)를 깨뜨리지 않고 분할되며, 일반 기술 XML 역시 바깥 부모 태그의 속성을 유지한 채 DB에 저장된다.

그렇다면 전처리를 이렇게 고쳐 놓으면 검색과 AI 답변 품질도 자동으로 좋아질까? 실제 공개 PDF 6종을 대상으로 전처리 개선 전후의 12개 질문을 비교한 결과는 그렇지 않았다. 구조 정돈 덕분에 전체 검색 구간 수는 707개에서 237개로 줄었다. 하지만 누락이나 오답 없이 **원문을 열지 않고 바로 참고 가능한 답변은 변경 전 `6/12`에서 변경 후 `5/12`로 늘지 않았다.**

원인을 추적해 보니 표와 본문 조각 자체는 색인에 모두 들어가 있었지만, 검색과 최종 문맥 선택 단계에서 실제 정답 표가 전체 후보 **9위\~31위**로 밀려나 있었다. 제한된 최종 입력 공간(24,000자)을 목차나 개요, 개정 이력 구간이 먼저 차지하면서 정작 전처리가 구조를 보존해 추출한 표 조각이 LLM에 전달되지 못한 것이다. XML 역시 설명 문장은 찾았는데 그 바로 아래 적힌 설정 코드 조각이 빠져 버리는 일이 남았다.

즉, 구조를 잃지 않고 잘라 저장하는 일은 전체 품질의 절반에 불과하다. 다음 4편에서는 이미 잘 저장해 둔 조각들을 **검색 단계에서 어떻게 빠뜨리지 않고 찾는지(하이브리드 융합)**부터 살펴본다. 이어서 **읽기 시점에 끊긴 목록과 설명·코드를 어떻게 다시 엮어 24,000자 예산 안에 담아내는지(`select_context()`)**를 다룬다.
