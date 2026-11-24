---
title: "DKM 아키텍처 6편: 정형 CSV 집계와 의미 모델 기반 근거 보존"
description: "CSV 형식 검사와 열 의미 매핑을 분리해 여러 표의 비율을 계산하고, 결합 시 분모 중복과 상위 조건 변경에 따른 근거 왜곡을 막는 구조를 정리한다."
pubDate: "2026-11-24 08:40:00"
tags: ["DKM", "CSV", "Ontology", "Evidence", "Snapshot", "DataValidation", "Python"]
categories: ["Architecture", "Backend"]
draft: false
---

[5편](/posts/dkm-series-part5-query-grounding-and-citation-control)에서는 대화 이력에서 빠진 주어를 복원하고 문맥 예산과 인용 표식을 코드로 제어하는 과정을 다루었다. 하지만 문서 검색기와 프롬프트 제어가 정확히 동작해도, CSV 시험 기록을 조건별로 걸러 비율을 구해야 하는 질문에는 답하기 어렵다.

예를 들어 `"전체 기록 중 25도 조건에서 검사 장비별 초기 불량률은 몇 퍼센트인가?"` 같은 질문을 생각해 보자. 문단 유사도 검색은 설명 문장만 찾아 줄 뿐, 수백 개 행을 조건으로 걸러 분모와 분자를 직접 세어 주지 못한다. 반대로 CSV 표 데이터를 그대로 AI에게 넘겨 계산을 맡기면, 표기가 다른 숫자를 빠뜨리거나 서로 다른 대상을 하나로 섞어 비율을 잘못 계산하기 쉽다.

DKM은 이 문제를 AI의 추론에 맡기지 않고 **고정된 파이썬 계산 로직**과 **각 열의 뜻과 단위를 기록한 DB 의미 모델**로 나누어 푼다. 계산은 코드가 맡고, `'어떤 열이 온도이고 어떤 단위를 쓰는가'` 같은 뜻과 단위만 코드 바깥에 따로 적어 두는 구조다. 덕분에 CSV 파일의 열 이름이 달라져도 파이썬 코드를 매번 고치지 않고 같은 계산기를 재사용할 수 있다.

6편에서는 고정 양식 전용 모듈에서 어떤 CSV 파일에도 쓸 수 있는 범용 집계 구조로 확장해 나가는 네 단계를 살펴본다. 먼저 단일 양식 전용 계산기가 겪는 한계를 확인하고, 파일 형식 검사와 열 의미 매핑을 어떻게 분리하는지 본다. 이어서 DB에 열의 뜻을 등록하고, 미완성 매핑 초안은 임시 저장하되 불완전한 실행만 막는 방법을 확인한다.

다음으로 두 표를 합칠 때 분모가 중복 계산되지 않게 막는 방법과, 같은 조건의 이전 결과를 재사용하면서 당시 결과를 불변 기록으로 보존하는 구조를 본다. 마지막으로 보고서의 질문마다 확인 항목(요건)을 나누어 관리하고, 상위 기준이 바뀌어도 이미 확인한 근거의 조건이 따라 바뀌지 않게 유지하는 방법을 다룬다.

---

## 1. 단일 양식 CSV 집계의 한계

일반 문헌 검색으로 표 집계 문제를 풀 수 없다면 가장 먼저 떠올릴 해법은 정형 CSV를 읽어 직접 조건을 거르고 비율을 계산하는 전용 모듈이다. 초기 DKM은 특정 시험(SRAM 메모리 읽기 시험)의 오류 기록 CSV를 처리하기 위해 전용 집계 모듈(`backend/knowledge/documents/sram.py`)을 먼저 만들었다. 파일 이름만 보면 특정 시험 표 하나에만 묶인 코드처럼 보인다. 하지만 먼저 한 양식에서 계산 정확도를 확보한 뒤, 2장과 3장에서 어떤 CSV든 열 이름만 연결해 쓰도록 일반화한다.

현장 시험 기록을 집계할 때 전체 행 수를 그대로 분모에 넣고 재시험이나 중복 행을 걸러 내지 않으면 불량률이 왜곡된다. 예를 들어 `1번 제품(S-01)`을 검사 장비 A에 처음 꽂아 시험했을 때 오류가 났다고 가정하자. 작업자가 단순 접촉 불량인지 확인하려고 제품을 다시 꽂아 재시험을 진행했고 통과 판정을 받았다. 그런데 집계 코드가 이 재시험 행까지 한꺼번에 분모에 넣거나 나중 결과로 덮어쓰면 문제가 생긴다. 첫 시험에서 오류가 난 제품이 `'시험 2번 중 오류 1번'`(`50%`)이 되거나 정상(`0%`)으로 잘못 집계되기 때문이다.

반대로 `11번 제품(S-11)`의 `'첫 시험'` 기록이 실수로 두 줄로 중복 기록되어 하나에는 `'오류'`, 다른 줄에는 `'통과'`가 적혀 있는 상황도 생긴다. 두 줄을 다 세면 제품 하나가 분모에 두 건으로 잡혀 비율이 왜곡된다. 임의로 앞선 한 줄만 골라도 파일 정렬 순서에 따라 불량률이 오락가락한다.

실제 시험 CSV에서 조건 필터링과 분모 집계가 어떻게 작동하는지 예시 표로 확인해 보자. 사용자가 **묶음 `LOT-1`, `25도`, `0.8V`** 조건에서 장비별 초기 불량률을 요청한 상황이다. (여기서 `시료 묶음(lot_id)`은 함께 시험을 거친 생산 또는 작업 단위다.)

| 행 번호 | 묶음(`lot_id`) | 제품 ID(`sample_id`) | 장비(`tester_id`) | 온도(`temperature_c`) | 전압(`voltage_v`) | 시험 구분(`attempt`) | 결과(`result`) | 집계 판단 |
|---|---|---|---|---|---|---|---|---|
| 2 | `LOT-1` | `S-01` | 장비 A | `25` | `0.80` | `initial` (첫 시험) | `read_error` (오류) | 장비 A 분모 포함 (오류 1건) |
| 3 | `LOT-1` | `S-02` | 장비 A | `25.0` | `0.8` | `initial` (첫 시험) | `pass` (정상) | `'25.0'`을 `'25'`와 같은 조건으로 맞춰 포함 |
| 4 | `LOT-1` | `S-04` | 장비 B | `25` | `0.8` | `initial` (첫 시험) | `pass` (정상) | 장비 B 분모 포함 (정상 1건) |
| 5 | `LOT-1` | `S-01` | 장비 A | `25` | `0.8` | `retest` (재시험) | `pass` (정상) | 첫 시험이 아니므로 제외 |
| 6 | `LOT-1` | `S-08` | 장비 A | `85` | `0.8` | `initial` (첫 시험) | `read_error` (오류) | 선택한 `25`도 조건 밖이라 제외 |
| 7, 8 | `LOT-1` | `S-11` | 장비 A | `25` | `0.8` | `initial` (2건 중복) | `read_error`, `pass` | 같은 `(제품, 장비)`의 첫 시험이 중복되어 2건 모두 제외 |

CSV의 열 목록과 행 데이터, 그리고 사용자가 선택한 조건을 받아 장비별 불량률과 계산에 포함된 행 번호를 반환하는 함수가 `sram.py`의 `calculate()`다. 이 함수는 오차를 막기 위해 아래 세 가지 원칙으로 동작한다.

1. **필수 7개 열 확인과 숫자 표기 형식 통일하기**: 먼저 시료 묶음(`lot_id`), 제품 ID, 장비, 온도, 전압, 시험 구분, 결과에 해당하는 7개 열이 모두 있는지 확인한다. 하나라도 빠지면 임의로 계산하지 않고 검증 오류(`HTTP 422`)를 반환해 처리할 수 없는 입력임을 알린다. 이어서 온도와 전압 조건은 단순 문자열 비교를 피한다. `'25' == '25.0'`이나 `'0.80' == '0.8'`을 글자 그대로 비교하면 `False`가 되어 3번 행이 비교에서 빠지기 때문이다. 그렇다고 부동소수점(`float`)으로 변환하면 이진 반올림 오차나 지수 표기가 섞여 비교 키가 어긋날 수 있다. 따라서 조건 문자열을 `Decimal` 타입으로 변환해 소수점 끝자리 표기를 통일한다. 이때 긴 지수 문자열로 변환 비용이 커지는 일을 막기 위해 **정수 7자리와 소수 6자리(총 13자리) 이내**의 숫자만 허용하며, `-0.0` 같은 음수 0도 `'0'`으로 맞춘다.
2. **재시험과 겹친 첫 시험을 제외하고 남은 행만 세기**: 먼저 집계 대상에서 빠지는 행(조건 누락, `85`도처럼 다른 조건, 재시험 `retest`, 제품 ID나 장비 이름 누락)을 걸러 제외 건수만 누적한다. 남은 `initial` 행은 `(제품, 장비)` 쌍으로 묶어 `2`건 이상 중복된 경우(`S-11`) 어느 쪽도 신뢰할 수 없으므로 해당 쌍을 전부 제외한다. 위 표에서는 장비 A가 `2`건 중 `1`건 오류(`50%`), 장비 B가 `1`건 중 `0`건 오류(`0%`)로 남는다. 조건에 맞는 행이 `0`건일 때 `'0%'`를 반환하면 사용자가 불량이 없는 것으로 오인할 수 있으므로, 검증 오류(`HTTP 422`)를 반환해 계산을 중단한다.
3. **제외 항목은 건수만, 계산에 포함된 행만 번호 남기기**: 수천 줄 CSV에서 제외된 모든 행 번호까지 응답에 실으면 결과 데이터가 불필요하게 커진다. 그래서 제외 사유별로는 건수만 요약해 보여 주고, 실제 분모에 포함된 행 번호만 장비별로 정렬해 남겨 나중에 원문 몇 번째 줄을 셌는지 찾아볼 수 있게 한다. (초기 `sram.py` 구현에서는 불량률 나눗셈 자체에 파이썬 기본 `float` 나눗셈을 사용하며, 이 정밀도 한계는 3장의 범용 계산기에서 `Decimal` 나눗셈으로 개선한다.)

```python
# backend/knowledge/documents/sram.py — 고정된 7개 열 기준 SRAM 초기 시험 불량률 집계
# - columns: 초기 전용 파일 리더가 중복 헤더 여부를 검사하고, 필수 7개 열(COLUMNS) 중 최소 1개라도 포함되어 있는지 확인한 뒤 넘긴 열 목록
#            (7개 열이 전부 있는지 최종 검증하는 역할은 아래 calculate()가 맡는다)
# - rows:    (원본 CSV 레코드 번호, {열 이름: 셀 문자열}) 튜플 리스트 (셀 안에 줄바꿈이 있어도 따옴표로 묶인 1개 행 번호를 유지)
# - filters: 사용자가 선택한 단일 lot_id(시료 묶음), temperature_c(온도), voltage_v(전압) 조건 객체
# - METHOD, RULES: API 응답에 계산 방식 식별자('sram-read-initial-v1')와 집계 기준 설명문을 함께 담는 상수
# - AppError: DKM 전역 HTTP 예외 래퍼 / condition(), condition_view(): 행 조건 추출과 응답 변환 내부 헬퍼 함수

COLUMNS = ('lot_id', 'sample_id', 'tester_id', 'temperature_c', 'voltage_v', 'attempt', 'result')
# 너무 긴 숫자나 지수 문자열이 들어와 Decimal 변환 비용이 커지는 것을 막기 위해 정수 7자리, 소수 6자리까지만 허용한다.
CONDITION_NUMBER = r'^[+-]?[0-9]{1,7}(?:\.[0-9]{1,6})?$'

def canonical_number(value):
    # 1. Decimal.normalize()를 거쳐 format(..., 'f')를 쓰면 '25'와 '25.00'은 같은 '25'로 통일되고,
    #    Decimal('100').normalize()가 만드는 지수 표기('1E+2')도 일반 숫자('100')로 통일된다.
    #    다만 -0.0처럼 음수 부호가 붙은 0은 format(..., 'f') 뒤에도 '-0'으로 남을 수 있으므로 0이면 항상 '0'을 반환한다.
    if not re.fullmatch(CONDITION_NUMBER, value):
        return None
    number = Decimal(value)
    return '0' if not number else format(number.normalize(), 'f')

def calculate(columns, rows, filters):
    # 2. 전용 파일 리더 단계에서는 7개 열 중 1개 이상만 있어도 통과하므로, 계산 직전에 필수 7개 열이 모두 있는지 재확인한다.
    if any(key not in columns for key in COLUMNS):
        raise AppError(422, 'sram_mapping_incomplete', '필수 컬럼이 없어 비교 조건을 확인할 수 없습니다.')

    selected = (filters.lot_id, canonical_number(filters.temperature_c), canonical_number(filters.voltage_v))
    # 사유별 제외 건수만 담아 응답 크기를 일정하게 유지한다.
    excluded = dict(outsideCondition=0, unknownCondition=0, retest=0, invalidRow=0, duplicateInitial=0)
    candidates = defaultdict(list)

    for number, row in rows:
        key = condition(row)
        # 3. 조건 값이 비었거나 형식이 틀린 행(unknownCondition)과, 형식은 맞지만 선택한 조건과 다른 행(outsideCondition)을 나누어 센다.
        if key is None:
            excluded['unknownCondition'] += 1
        elif key != selected:
            excluded['outsideCondition'] += 1
        else:
            sample, tester = row['sample_id'].strip(), row['tester_id'].strip()
            attempt, result = row['attempt'].strip(), row['result'].strip()
            # 4. 재시험(retest)은 첫 시험의 불량률이 깎이지 않게 제외 건수만 올린다.
            #    알 수 없는 시험 구분값이거나 제품 및 장비 식별자가 비어 있으면 invalidRow로 분류한다.
            if attempt == 'retest':
                excluded['retest'] += 1
            elif attempt != 'initial' or not sample or not tester:
                excluded['invalidRow'] += 1
            else:
                candidates[sample, tester].append((number, result))

    groups = defaultdict(list)
    errors = Counter()
    for (_, tester), records in candidates.items():
        # 5. 같은 (제품, 장비)에 initial 행이 2건 이상이면 어느 줄이 진짜인지 추측하지 않고 전부 제외한다.
        if len(records) > 1:
            excluded['duplicateInitial'] += len(records)
            continue
        number, result = records[0]
        if result not in ('pass', 'read_error'):
            excluded['invalidRow'] += 1
            continue
        # 실제 분모에 포함된 행 번호만 모아 나중에 사용자가 원문 몇 번 행을 셌는지 대조할 수 있게 한다.
        groups[tester].append(number)
        # 파이썬에서 bool은 int의 하위 타입이므로 read_error일 때 True(1)만 카운터에 누적된다.
        errors[tester] += result == 'read_error'

    if not groups:
        # 6. 조건에 맞는 행이 0건일 때 '0%'를 반환하면 사용자가 불량이 0%인 것으로 오인할 수 있으므로 422 오류로 알린다.
        raise AppError(422, 'sram_no_comparable_rows', '이 조건에서 집계할 수 있는 최초 시험이 없습니다. 비교 결과는 미확인입니다.')

    return dict(
        method=METHOD, filters=condition_view(selected), rules=RULES, totalRows=len(rows),
        excluded=excluded,
        groups=[
            dict(
                testerId=tester, errors=errors[tester], total=len(numbers),
                # 7. 초기 모듈은 일반 float 나눗셈을 쓰며, sorted()로 장비와 행 번호 순서를 고정해 매번 같은 출력을 보장한다.
                errorRate=errors[tester] / len(numbers), rowNumbers=sorted(numbers),
            )
            for tester, numbers in sorted(groups.items())
        ],
    )
```

하지만 이 전용 구조에는 뚜렷한 한계가 있다. 열 이름(`lot_id`, `temperature_c`, `result`)을 파이썬 코드 안에 직접 적어 둔 구조이기 때문이다. 다른 시험 장비에서 `machine_no`나 `temp`처럼 열 이름만 다르게 저장한 CSV를 올려도 파이썬 계산 코드를 새로 짜야 한다.

열 이름을 코드에 고정하지 않기로 하면, 파일을 처음 올리는 단계에서도 `"이 파일에 temperature_c 열이 있는가"`를 기준으로 업로드를 막을 수 없다. 그래서 DKM은 CSV를 다루는 과정을 역할이 다른 두 단계로 분리했다.

- **파일 형식 검사** (`backend/knowledge/documents/csv_records.py`): 각 열이 온도인지 가격인지 내용은 묻지 않는다. 오직 인코딩과 쉼표, 각 행의 열 개수가 깨지지 않은 정상 표 파일인지만 먼저 확인한다.
- **열 의미 매핑** (다음 2장): 파일 형식 검사를 통과해 안전하게 읽어 들인 표를 바탕으로, 비로소 `"3번째 열이 섭씨 측정 온도"`라는 뜻을 연결한다.

업로드 시점의 파일 형식 검사기가 입력을 나누어 처리하는 기준은 세 가지다.

- **UTF-8 검사와 `NUL(\x00)` 바이트 즉시 차단하기**: UTF-8 디코딩으로 한글이나 단위 기호가 깨진 파일을 막는다. 특히 문자열 안에 `NUL(\x00)` 제어 문자가 섞여 있으면 일반 텍스트가 아니라 바이너리 파일의 확장자만 `.csv`로 바꿨거나 데이터가 손상된 상태다. 이를 그대로 넘기면 CSV 파서나 문자열 DB 저장 과정에서 오류가 날 수 있으므로 업로드 단계에서 검증 오류(`HTTP 422`)로 즉시 거부한다.
- **파일 크기, 행 수, 열 수 상한으로 서버 자원 보호하기**: 파일 크기(`2MB`)나 행 수(`5,000`행) 상한을 넘기면 업로드 요청 자체를 용량 초과 오류(`HTTP 413`)로 즉시 거부한다. 열 개수(`32`개)나 헤더/셀 길이 상한을 넘긴 파일도 검증 오류(`HTTP 422`)로 막아 거대한 표 한 건이 자원을 독점하지 않게 한다.
- **형식 오류가 남은 행도 지우지 않고 위치 보존하기**: 상한과 인코딩을 통과한 파일에도 빈 헤더, 중복 헤더, 열 개수가 어긋난 행이 남을 수 있다. 이때는 업로드를 받아들이고 오류 목록만 기록한다. 깨진 행을 바로 지워 버리면 사용자가 몇 번째 줄을 고쳐야 하는지 알 수 없기 때문이다. 대신 이 오류가 해결되지 않은 CSV 버전으로는 매핑 저장과 검증, 계산 실행을 모두 검증 오류(`HTTP 422`)로 막는다. 사용자는 문제를 고친 새 CSV 버전을 다시 올려야 계산을 진행할 수 있다.

---

## 2. 의미 모델과 열 매핑

파일 형식 검사를 통과해 표의 모든 행을 안전하게 읽었다면, 이제 `"어떤 열이 무엇을 뜻하고 어떤 단위를 쓰는지"`를 파이썬 코드 바깥에 적어 둘 차례다.

예를 들어 기존 검사 장비가 내보낸 CSV에는 장비 이름이 `tester_id`, 온도가 `temperature_c`라는 열 이름으로 들어 있다. 반면 협력사에서 새로 들여온 설비의 CSV에는 똑같은 데이터가 `machine_no`와 `temp`라는 전혀 다른 열 이름으로 저장되어 있을 수 있다. 열 이름은 달라도 두 파일이 가리키는 뜻(검사 장비, 섭씨 측정 온도)은 같다.

DKM은 **공통 개념, 열의 뜻(속성)과 단위, 개념 간 관계를 DB에 의미 모델로 먼저 등록**해 둔다. 이어서 각 CSV의 실제 열 이름을 그 속성에 짝지어 연결한다. 덕분에 새 장비의 CSV가 추가되어도 담당자가 화면에서 열 이름만 연결하면 1장의 `sram.py`처럼 코드를 새로 짜지 않고도 같은 집계 코드를 재사용할 수 있다.

| 구성 요소 | 역할 | 구체 예시 |
|---|---|---|
| **개념 (Concept)** | 시험 대상이나 주체를 구분하는 큰 범주 | 시료(`Sample`), 검사 장비(`Tester`) |
| **속성 (Property)** | 개념이 가지는 항목과 자료형, 단위 | 측정 온도(숫자, `°C`), 판정 결과(문자, `pass`/`read_error`) |
| **관계 (Relation)** | 서로 다른 두 표의 개념이 짝지어지는 규칙 | 시험 기록(`sample_id`) ↔ 최종 승인 목록(`sample_id`) |
| **열 매핑 (Mapping)** | 특정 CSV의 실제 열 이름을 속성에 연결 | `temp` 열 ➔ 측정 온도 속성 연결 |

이처럼 DB의 의미 모델 정의와 CSV 열 매핑을 나누어 등록할 때는 **수정할 때마다 기존 내용을 덮어쓰지 않고 새 버전을 쌓아 두는 원칙**이 중요하다. 만약 담당자가 과거 기록에 쓰인 `측정 온도` 속성의 단위를 `°C`에서 `°F`로 덮어쓰거나 열 매핑을 고쳐 버리면 어떻게 될까? 지난주에 `'25°C'` 기준으로 저장해 둔 계산 결과가 갑자기 `25°F`나 다른 열을 가리키게 되어 근거가 왜곡된다. 새 버전으로 쌓아 두면 옛 계산 결과는 당시 버전의 모델과 매핑에 그대로 고정된다.

모델이 준비되면 담당자는 CSV의 실제 열(`temp`)을 모델 속성(`측정 온도`)과 짝짓는다. 아울러 한 CSV 파일 안에 실수로 똑같은 기록이 두 번 들어갔을 때 무엇으로 중복을 가릴지 기준이 되는 **중복 판별 열**도 함께 지정한다.

담당자가 만든 매핑이 CSV 헤더 및 DB 의미 모델과 맞는지 점검하는 함수가 `backend/knowledge/evidence/calculation.py`의 `validate_mapping()`이다. 이어서 검증된 매핑을 바탕으로 필터링과 비율 계산을 수행하는 범용 계산 함수가 같은 파일의 `calculate()`다. 매핑 검증과 실행을 나누는 세 가지 원칙은 다음과 같다.

1. **오류가 남아 있어도 매핑 초안 저장은 허용하기**: 열이 수십 개씩 들어 있는 CSV는 한 번에 다 연결하지 못하고 작업 도중 저장해야 할 때가 많다. 존재하지 않는 열 이름(`temp_missing`)을 적었거나 한 속성에 열 두 개를 중복 연결했더라도, 저장 요청 자체를 실패 처리하면 작성 중이던 작업이 사라진다. 그래서 `validate_mapping()`은 검증 오류를 바로 예외로 던지지 않고 목록에 모아 반환한다. 덕분에 API는 미완성 초안도 정상 저장(`HTTP 201`)할 수 있다. 중복 판별 열이나 여러 표를 합칠 때 쓰는 대상 식별 기준이 비어 있어도 단일 표 집계는 가능하므로 참고용 경고(`warning`)로만 남긴다.
2. **오류(`error`)가 0개일 때만 실행 가능한 작업 알려 주기**: 저장된 초안으로 어떤 분석을 실행할 수 있는지는 `error` 수준 오류가 `0`건인지 확인한 뒤 결정한다. 오류가 전혀 없으면 연결 구성에 따라 실행 가능한 작업 목록(`capabilities`)을 반환한다. 이 목록에는 원본 행 조건 조회(`records`), 비율 집계(`aggregate`), 두 표의 관계 조회(`relation`)가 들어간다.
3. **계산 실행 직전에 다시 확인해 불완전한 실행만 막기**: 앞선 예처럼 `temp_missing` 오류가 남은 미완성 초안을 선택해 비율 집계(`aggregate`)를 요청하면 어떻게 될까? 초안 저장은 통과하지만, 계산을 실행하는 범용 `calculate()`가 맨 앞에서 `validate_mapping()`을 한 번 더 호출한다. 요청한 작업이 `capabilities` 목록에 없는 것을 확인하면 검증 오류(`HTTP 422`)를 반환해 불완전한 실행을 막는다.

```python
# backend/knowledge/evidence/calculation.py — 임시 저장은 허용하고 실행 가능한 작업 범위만 판별하는 매핑 검증
# - 역할: 담당자가 작성한 매핑 초안이 실제 CSV 헤더와 DB 의미 모델에 맞는지 점검해 오류 목록과 capabilities를 반환한다.
# - 사전 맥락: content는 Pydantic 스키마 검사를, columns와 rows는 csv_records 형식 검사를 이미 통과한 상태다.
#              (생략된 뒷부분에서는 3장 다중 표 결합용 대상 식별 기준, 행 관계, 함께 묶을 참고 문헌 구간까지 검증한다.)
# - content: 열 매핑(fields), 중복 판별 열(identityColumns) 등이 담긴 딕셔너리 / model: 불변 버전으로 저장된 의미 모델 딕셔너리
# - columns: 원본 CSV의 열 이름 목록 / rows: 원본 레코드 목록
# - MAX_RECORDS: 한 자료에서 처리 가능한 최대 레코드 상한(5,000건)

MAX_RECORDS = 5000

def validate_mapping(content, model, columns, rows, passages):
    """불완전한 매핑도 초안 저장은 허용하며, capabilities 목록으로 실행 가능 여부를 알린다."""
    issues = []

    def issue(code, message, severity="error", **location):
        issues.append({"code": code, "message": message, "severity": severity, **location})

    properties = {item["key"]: item for item in model.get("properties", [])}
    fields = content.get("fields", [])

    # 1. 유효하지 않은 매핑을 놓치지 않도록 행 수 상한(5,000건), 중복 헤더, 빈 매핑, 동일 속성 중복 연결을 확인한다.
    #    한 모델 속성에 CSV 열 2개를 중복 연결하면 어느 열 값을 세어야 할지 모호해지므로 DUPLICATE_PROPERTY로 막는다.
    if len(rows) > MAX_RECORDS:
        issue("RECORD_LIMIT", "처리할 수 있는 레코드 수를 넘었습니다.")
    if len(columns) != len(set(columns)):
        issue("AMBIGUOUS_COLUMNS", "이름이 같은 컬럼을 구분할 수 없습니다.")
    if not fields and not content.get("passages"):
        issue("EMPTY_MAPPING", "연결할 컬럼이나 문헌 구간을 선택해 주세요.")
    keys = [field.get("propertyKey") for field in fields]
    if len(keys) != len(set(keys)):
        issue("DUPLICATE_PROPERTY", "한 속성을 여러 컬럼에 중복 연결할 수 없습니다.")

    # 2. 매핑된 열이 원본 CSV에 없거나 속성이 의미 모델에 없으면 error 등급 오류로 기록한다.
    #    여기서 raise로 끊지 않고 issues에 모아 두어야, 작업 도중 임시 저장(HTTP 201)이 실패하지 않는다.
    for field in fields:
        column, key = field.get("column"), field.get("propertyKey")
        if column not in columns:
            issue("UNKNOWN_COLUMN", "원문에 없는 컬럼입니다.", column=column)
        if key not in properties:
            issue("UNKNOWN_PROPERTY", "의미 모델에 없는 속성입니다.", propertyKey=key)

    for column in content.get("identityColumns", []):
        if column not in columns:
            issue("UNKNOWN_IDENTITY_COLUMN", "식별 컬럼이 원문에 없습니다.", column=column)
    # 3. 중복 판별 열(identityColumns)이 비어 있어도 단일 파일 내부 집계는 동작하므로 warning으로만 남긴다.
    if fields and not content.get("identityColumns"):
        issue("MISSING_RECORD_KEY", "레코드 중복 판별 컬럼이 없어 원문 위치로만 구분합니다.", "warning")

    # ... (생략: 누락 및 중복 정책, 3장 다중 표 결합용 대상 식별 기준 identities, 행 관계와 참고 문헌 구간 검증) ...

    # 4. error 등급 이슈가 0건일 때만 valid=True가 되며, 가능한 작업 목록(capabilities)에 항목을 채운다.
    #    유효한 매핑이면 항상 records를 허용하고, 열 매핑(fields)이 있을 때만 aggregate를 추가한다.
    valid = not any(item["severity"] == "error" for item in issues)
    capabilities = []
    if valid:
        capabilities.append("records")
        if fields:
            capabilities.append("aggregate")
        # ... (생략: 매핑에 행이나 문헌 관계 선언, 또는 식별 범위 scope가 있으면 'relation'도 capabilities에 추가) ...
    return {"valid": valid, "issues": issues, "capabilities": capabilities}
```

---

## 3. 두 표 결합과 계산 결과 보존

단일 CSV의 열을 의미 모델에 연결해 비율을 계산할 수 있게 되더라도 곧 다음 문제가 나타난다. 필요한 데이터가 한 파일에 모여 있지 않고 두 CSV 파일에 나뉘어 있는 경우다. 예를 들어 **CSV A**에는 제품별 시험 결과(`sample_id`, `tester_id`, `result`)가 들어 있다고 하자. 반면 **CSV B**에는 최종 품질 승인을 통과한 확정 제품 목록(`sample_id`, `approved_at`)만 따로 담겨 있다. 최종 승인된 제품만 추려 CSV A의 장비별 불량률을 계산하려면, 두 파일을 공통 번호(`sample_id`)로 짝지어 합쳐야 한다. (비율 집계 모드에서는 왼쪽 주 표인 `CSV A`의 열로만 그룹과 필터를 잡고, `CSV B`는 1:1 존재 여부로 `CSV A`의 대상을 거르는 용도로 동작한다.)

### 두 표를 안전하게 합쳐 비율 구하기

두 표를 `sample_id` 문자열만 보고 검증 없이 이어 붙이면 두 가지 계산 오차가 생긴다.

- **출처가 다른데 번호만 같은 대상의 결합**: 서로 다른 부서나 협력사 시스템이 각각 `1번, 2번, ..., 100번`처럼 독자적으로 일련번호를 붙이는 경우가 많다. CSV A의 `100`번은 A 부서 물건이고 CSV B의 `100`번은 협력사 물건이라면 표기만 같을 뿐 전혀 다른 대상이다. 같은 대상이라는 근거가 없는데 합치면 엉뚱한 기록이 섞인다.
- **일대다 매칭으로 분모가 부풀려지는 오류**: CSV A에는 전체 `4`건 중 `100`번 시험 기록 `1`건(오류)이 있어 불량률이 `25%`였다고 가정하자. 이때 CSV B에 `100`번의 승인 이력이 `2`줄로 중복 기록되어 있을 수 있다. 일반 SQL 조인처럼 `A 1행 x B 2행`을 그대로 붙이면 `100`번 행이 `2`줄로 복제되면서 오류가 `2`건, 전체 분모가 `5`건(`40%`)으로 부풀려진다.

| 결합 상황 | 일반 SQL 조인 결과 | DKM 결합 검증 결과 | 방지하는 오류 |
|---|---|---|---|
| A와 B 모두 `sample_id=100`이지만 발급 출처가 다름 | 두 행을 같은 대상으로 합침 | 식별 범위 불일치로 결합 거부 (`HTTP 422`) | 다른 부서나 시스템의 대상 혼용 방지 |
| A(`sample_id=100`) `1`행이 B의 `2`행과 겹침 | 행이 `2`개로 늘어나 분모 왜곡 | 다중 매칭으로 제외 | `25% -> 40%` 식의 분모와 분자 중복 집계 차단 |
| A와 B가 정확히 `1:1`로 짝지어지고 식별 범위가 같음 | `1`행 결합 | 정상 결합 후 분모에 포함 | 검증된 대상만 정확히 비율에 반영 |

이 문제를 막으며 어떤 CSV든 매핑 정보를 받아 비율을 계산하는 범용 함수가 `backend/knowledge/evidence/calculation.py`의 `calculate()`다. 같은 파일 안에는 두 표를 `1:1`로 짝짓는 내부 결합 로직이 함께 들어 있다. 계산에 앞서 각 CSV의 원본 행은 중간 추적 레코드 목록으로 정리된다. 여기에는 변환된 값과 제외 사유가 함께 기록되며, 값이 비었거나 숫자 형식이 틀렸거나 표 안에서 중복 판별 열이 겹친 행에는 이미 제외(`'excluded'`) 표시가 붙는다. `calculate()`는 1장의 `sram.py` 계산기의 `float` 나눗셈 한계를 함께 해결하면서 아래 네 가지 규칙으로 결합 오차와 반올림 오차를 차단한다.

1. **두 표가 같은 버전의 의미 모델과 단위를 쓰는지 확인하기**: 서로 다른 버전의 의미 모델을 참조하면 속성 이름이 같더라도 뜻이 다를 수 있다. 또한 두 표를 연결할 양쪽 기준 속성끼리 자료형이나 단위(예: 섭씨 `°C`와 화씨 `°F`)가 달라도 합칠 수 없으므로 검증 오류(`HTTP 422`)로 막는다. 아울러 의미 모델의 관계 정의에 `"최근 30일 이내 시험만 연결"`처럼 사람이 읽는 부가 조건 문장이 적혀 있어도, 코드가 이를 필터로 자동 변환해 거르지 않는다. 대신 `"서술 조건은 자동 검증하지 않았다"`는 한계 안내 문구를 함께 남긴다.
2. **복합 키 일부만으로 결합하는 편법을 막고 같은 식별 범위 검증하기**: 두 표를 합칠 때는 연결 속성을 하나만 받는다. 따라서 `'제조 묶음 + 제품 번호'` 두 열을 합쳐야만 구별되는 대상이라면 `'제품 번호'` 한 열만 떼어 합치는 것을 허용하지 않고 검증 오류(`HTTP 422`)로 막는다. 아울러 두 표의 번호가 같은 시스템이나 번호 체계에서 발급되었음을 뜻하는 **식별 범위(entity scope)**가 비어 있지 않고 양쪽 모두 같아야 결합을 허용한다. 개념별 대상 식별 기준(`identities`)이 지정된 경우에는 `'00100'`과 `'100'`이 숫자 정규화로 같은 값이 되지 않도록 원본 셀 문자열을 그대로 대조한다.
3. **1:1로 짝지어지는 행만 남기고 나머지는 분모에서 빼기**: 어느 한쪽에서라도 같은 연결 키가 `2`건 이상 나오면 어느 짝이 맞는지 임의로 고르지 않는다. 이런 행은 `'다중 매칭'`으로 표시해 연결 쌍 목록(`pairs`)에서 빼며, 짝이 없거나 앞 단계에서 이미 제외(`'excluded'`)된 행과 짝지어진 경우도 `'미매칭(unmatched)'`으로 분류해 연결 목록에 넣지 않는다. 이 단계에서는 `'excluded'`가 아니라 `'unmatched'` 표시만 붙으므로, 뒤따르는 계산 루프는 연결에 성공한 행 목록에 들어 있는지도 별도로 확인해 분모에서 걸러 낸다.
4. **28자리 `Decimal` 정밀 나눗셈과 분모 `0` 처리**: 파이썬 기본 `float`는 `0.1 + 0.2`처럼 이진 표현 오차가 생겨 여러 비율을 비교할 때 끝자리가 어긋난다. 또한 임의 길이(최대 `100`자) 입력 숫자를 문자열로 정리할 때 일반 자릿수 정규화 함수를 그대로 쓰면 실행 환경의 정밀도에 맞춰 반올림될 수 있다(1장에서는 13자리 이내로 제한했기에 안전했다). 그래서 DKM은 계산 블록 안에서만 유효 숫자 `28`자리 정밀도의 `Decimal` 나눗셈을 수행한다. 이어서 별도 포맷 도우미로 소수점 뒤 불필요한 `0`만 제거해 정확한 비율을 구한다. 필터를 통과해 집계 그룹은 만들어졌지만 별도 분모 조건(`denominator`)에 맞는 행이 없어 분모가 `0`이 될 수도 있다. 이때는 `ZeroDivisionError`로 전체 집계가 중단되지 않게 해당 집계 그룹의 비율만 `None`으로 비워 둔다.

먼저 `calculate()` 내부의 결합 로직이 어떻게 잘못된 짝짓기와 1:N 매칭을 걸러 내는지 코드로 확인하자.

```python
# backend/knowledge/evidence/calculation.py — 두 표의 일대일 결합 검증
# - 역할: _join()은 calculate() 내부에서만 호출해 두 CSV 표를 1:1로 짝짓는 내부 헬퍼 함수다.
# - 사전 맥락: _mapped()가 이미 각 CSV의 원본 행을 검사해 누락값, 숫자 형식 오류, 표 내부 중복 행에 'excluded' 상태(role)를 붙여 entries에 넣은 상태다.
# - 내부 도우미: _invalid()(HTTP 422 검증 오류 발생), _properties()(모델 속성 딕셔너리 반환), collections.defaultdict

def _join(mappings, models, entries, join):
    # 1. 결합 요청 딕셔너리 키(5개), 서로 다른 두 매핑, 제3의 CSV 혼입 여부, 동일 의미 모델 버전을 차례로 검증한다.
    allowed = {"leftMappingRevisionId", "rightMappingRevisionId", "leftPropertyKey", "rightPropertyKey", "relationKey"}
    if not isinstance(join, dict) or set(join) != allowed:
        _invalid("연결에는 양쪽 매핑·속성과 관계 정의가 필요합니다.")
    by_id = {mapping["revisionId"]: mapping for mapping in mappings}
    left, right = by_id.get(join["leftMappingRevisionId"]), by_id.get(join["rightMappingRevisionId"])
    if left is None or right is None or left is right:
        _invalid("서로 다른 두 매핑을 연결해 주세요.")
    if {m["revisionId"] for m in mappings if m.get("fields")} != {left["revisionId"], right["revisionId"]}:
        _invalid("이번 연결은 두 레코드 자료와 설명 문헌만 함께 선택할 수 있습니다.")
    if left["modelRevisionId"] != right["modelRevisionId"]:
        _invalid("다른 의미 모델의 같은 key를 같은 뜻으로 추정할 수 없습니다. 공통 모델 판본으로 매핑해 주세요.")

    # 2. 연결할 양쪽 기준 속성끼리 개념, 자료형(valueType), 단위(unit)가 관계 정의와 정확히 맞는지 확인한다.
    left_model, right_model = models[left["modelRevisionId"]], models[right["modelRevisionId"]]
    left_prop = _properties(left_model).get(join["leftPropertyKey"])
    right_prop = _properties(right_model).get(join["rightPropertyKey"])
    relation = next((r for r in left_model.get("relations", []) if r["key"] == join["relationKey"]), None)
    if (not left_prop or not right_prop or not relation
            or relation["sourceConceptKey"] != left_prop["conceptKey"]
            or relation["targetConceptKey"] != right_prop["conceptKey"]
            or left_prop.get("valueType") != right_prop.get("valueType")
            or left_prop.get("unit") != right_prop.get("unit")):
        _invalid("연결 속성의 개념·자료형·단위가 관계 정의와 맞지 않습니다.")

    # 3. 식별 범위(scope)와 단일 식별 열 검사를 통해 다른 부서의 동일 번호 혼용 및 복합 키 일부 결합을 막는다.
    bound_identities = bool(left.get("identities") or right.get("identities"))
    if bound_identities:
        bindings = []
        for mapping, key, prop in ((left, join["leftPropertyKey"], left_prop), (right, join["rightPropertyKey"], right_prop)):
            binding = next((b for b in mapping.get("identities", []) if b["conceptKey"] == prop["conceptKey"]), None)
            field = next((f for f in mapping.get("fields", []) if f["propertyKey"] == key), None)
            if not binding or not field or binding["columns"] != [field["column"]]:
                _invalid("연결 속성이 해당 개념의 전체 식별 컬럼과 일치해야 합니다. 복합 키 일부만으로 연결할 수 없습니다.")
            bindings.append(binding)
        scope = bindings[0].get("scope", "").strip()
        if not scope or scope != bindings[1].get("scope", "").strip():
            _invalid("연결하는 두 개념의 식별 범위를 같게 명시해 주세요.")
    else:
        scope = left.get("identityScope", "").strip()
        if not scope or scope != right.get("identityScope", "").strip():
            _invalid("같은 식별 범위를 명시한 자료만 연결할 수 있습니다.")

    # 4. 양쪽 표 레코드를 연결 키 값 기준으로 모은 뒤, sorted(set(...) | set(...))로 결정적 순서대로 짝짓는다.
    indexes, missing = [], 0
    for mapping, key in ((left, join["leftPropertyKey"]), (right, join["rightPropertyKey"])):
        if key not in {field["propertyKey"] for field in mapping.get("fields", [])}:
            _invalid("연결 속성이 해당 자료의 컬럼에 매핑되지 않았습니다.")
        index = defaultdict(list)
        for entry in entries:
            if entry["mappingRevisionId"] == mapping["revisionId"] and entry["kind"] == "record":
                value = entry["values"].get(key)
                if bound_identities:
                    # 대상 식별 기준(identities)이 있으면 숫자 정규화 전 원본 셀 문자열을 써서 '00100'과 '100'을 구분한다.
                    field = next(f for f in mapping["fields"] if f["propertyKey"] == key)
                    raw = entry["cells"].get(field["column"])
                    value = str(raw) if raw is not None and str(raw).strip() else None
                if value is None:
                    missing += 1
                    entry["roles"] = list(dict.fromkeys([*entry["roles"], "unmatched"]))
                    entry.setdefault("reason", "missing_join_key")
                else:
                    index[value].append(entry)
        indexes.append(index)

    pairs, unmatched, multiple = [], missing, 0
    for key in sorted(set(indexes[0]) | set(indexes[1])):
        lhs, rhs = indexes[0].get(key, []), indexes[1].get(key, [])
        # 5. 한쪽이라도 2건 이상 나오거나(1:N), 앞 단계에서 이미 제외('excluded')된 행과 엮이면 결합을 거부한다.
        if len(lhs) > 1 or len(rhs) > 1:
            role, reason = "unmatched", "multiple_matches"
            multiple += len(lhs) + len(rhs)
        elif not lhs or not rhs:
            role, reason = "unmatched", "no_match"
            unmatched += len(lhs) + len(rhs)
        elif any("excluded" in entry["roles"] for entry in lhs + rhs):
            role, reason = "unmatched", "invalid_matching_record"
            unmatched += 2
        else:
            # (실제 반환 pair에는 bound_identities용 sourceEntityId/targetEntityId와 원본 행 번호 leftRows/rightRows도 함께 담는다.)
            pairs.append({"leftInputId": lhs[0]["inputId"], "rightInputId": rhs[0]["inputId"],
                          "relationKey": join["relationKey"], "key": key})
            for entry in lhs + rhs:
                entry["roles"].append("related")
            continue
        for entry in lhs + rhs:
            # dict.fromkeys()로 기존 역할 순서를 유지하면서 중복된 'unmatched'만 빼고, filter(None, ...)로 앞쪽 쉼표를 막는다.
            entry["roles"] = list(dict.fromkeys([*entry["roles"], role]))
            entry["reason"] = ",".join(filter(None, (entry.get("reason"), reason)))
    return {"pairs": pairs, "matched": len(pairs), "unmatched": unmatched, "multiple": multiple,
            "basis": "explicit_equality", "conditions": relation.get("conditions", ""),
            "conditionsVerified": not bool(relation.get("conditions", ""))}
```

이제 범용 `calculate()` 본문이 위 결합 결과에서 `pairs`에 들지 못한 `'unmatched'` 행을 어떻게 분모에서 제외하는지 보자. 앞선 결합 단계에서는 실패 사유로 `'unmatched'`만 붙고 `'excluded'`는 붙지 않는다. 따라서 아래 루프는 `pairs`에 포함된 행인지 별도로 확인해 분모에서 걸러 낸다. 이어서 그룹별 비율을 유효 숫자 `28`자리 `Decimal`로 계산하는 과정도 함께 확인한다.

```python
# backend/knowledge/evidence/calculation.py — 실행 가능 작업(capabilities) 재확인, 미매칭 행 분모 제외, Decimal 비율 계산
# - 역할: 1장의 sram.py 계산을 일반화해, 매핑 정보가 주어진 어떤 CSV든 결합과 필터링을 거쳐 비율을 계산한다.
# - kind:     분석 모드('records': 행 조회, 'relation': 관계 확인, 'aggregate': 비율 집계)
# - mappings: 선택한 매핑 버전 목록 / models: 의미 모델 버전 딕셔너리 / sources: CSV 원본 행과 문서 문단 딕셔너리
# - spec:     filters(AND 조건 목록, 각 조건 values는 OR), groupBy, numerator, denominator(선택), join이 담긴 딕셔너리
# - 내부 도우미와 상수: MAX_RECORDS(5,000건), _invalid(), _source(), _mapped(), _properties(), _predicate(), _number(), Decimal, localcontext

def calculate(kind, mappings, models, sources, spec):
    if kind not in {"records", "relation", "aggregate"}:
        _invalid("지원하지 않는 근거 종류입니다.")
    if not mappings or len(mappings) > 10 or len({m["revisionId"] for m in mappings}) != len(mappings):
        _invalid("서로 다른 매핑을 1~10개 선택해 주세요.")
    # ... (생략: spec 허용 키 및 분석 모드별 필수 필드 사전 검사) ...

    entries, limitations = [], []
    # 1. 계산 직전 모든 매핑마다 validate_mapping()을 다시 호출해, 불완전한 매핑임을 알리는 검증 오류(HTTP 422)로 막는다.
    #    열 매핑(fields) 없이 참고용 문헌만 묶은 보조 자료는 aggregate 대신 records 작업만 가능한지 확인한다.
    for mapping in mappings:
        model, source = models.get(mapping["modelRevisionId"]), _source(mapping, sources)
        if model is None:
            _invalid("매핑이 가리키는 의미 모델 판본이 없습니다.")
        validation = validate_mapping(mapping, model, source.get("columns", []), source.get("rows", []), source.get("passages", []))
        required_capability = "records" if kind == "aggregate" and not mapping.get("fields") else kind
        if required_capability not in validation["capabilities"]:
            _invalid("매핑이 불완전하여 요청한 근거를 만들 수 없습니다.", "INCOMPLETE_MAPPING")
        limitations.extend(item["message"] for item in validation["issues"])
        entries.extend(_mapped(mapping, model, source))

    # 2. 결합 조건(join)이 있으면 _join()을 먼저 실행해 pairs를 구하고, 관계 정의의 자연어 조건은 미검증 한계로 남긴다.
    joined = _join(mappings, models, entries, spec["join"]) if spec.get("join") else None
    if joined is not None and not joined["conditionsVerified"]:
        limitations.append("연결 키의 일치는 확인했지만 관계 정의의 서술 조건은 자동 검증하지 않았습니다.")

    # ... (생략: 전체 레코드와 문헌 엔트리 합산 5,000건 상한 확인, relation 모드 반환, join 없는 다중 CSV aggregate 차단) ...

    csv_mappings = [mapping for mapping in mappings if mapping.get("fields")]
    # 3. 비율 집계(aggregate) 시 결합이 있으면 왼쪽 매핑(leftMappingRevisionId)을 주 대상(primary)으로 삼아 groupBy와 비율 열을 검증한다.
    primary = next((m for m in mappings if joined and m["revisionId"] == spec["join"]["leftMappingRevisionId"]),
                   csv_mappings[0] if csv_mappings else mappings[0])
    properties = _properties(models[primary["modelRevisionId"]])
    mapped_keys = {field["propertyKey"] for field in primary.get("fields", [])}
    predicates = [_predicate(item, properties) for item in spec.get("filters", [])]
    group_by = spec.get("groupBy", [])
    numerator = _predicate(spec.get("numerator"), properties) if kind == "aggregate" else None
    denominator = _predicate(spec["denominator"], properties) if spec.get("denominator") else None
    if (set(group_by) | {k for k, _ in predicates} | {p[0] for p in (numerator, denominator) if p}) - mapped_keys:
        _invalid("계산에 필요한 속성이 자료에 매핑되지 않았습니다.")
    # ... (생략: records 모드에서 여러 CSV를 함께 조회할 때 공통 필터 속성이 각 자료에 있는지 추가 검증) ...

    matched_ids = {pair["leftInputId"] for pair in joined["pairs"]} if joined else None
    if kind == "records" and joined:
        matched_ids.update(pair["rightInputId"] for pair in joined["pairs"])

    groups, used = {}, []
    record_entries = [entry for entry in entries if entry["kind"] == "record"
                      and (kind == "records" or entry["mappingRevisionId"] == primary["revisionId"])]
    for entry in record_entries:
        if "excluded" in entry["roles"]:
            continue
        reason = None
        # 4. _join()이 실패시킨 행은 'excluded'가 아니라 'unmatched'만 붙어 있으므로, matched_ids 대조로 분모에서 빼야 한다.
        if matched_ids is not None and entry["inputId"] not in matched_ids:
            reason = "join_not_unique_or_unmatched"
        elif any(entry["values"].get(key) not in values for key, values in predicates):
            reason = "filter_mismatch"
        if reason:
            entry["roles"].append("excluded")
            entry["reason"] = ",".join(filter(None, (entry.get("reason"), reason)))
            continue
        entry["roles"].append("used")
        used.append(entry)
        if kind == "aggregate":
            group_key = tuple(entry["values"][key] for key in group_by)
            group = groups.setdefault(group_key, {"key": dict(zip(group_by, group_key)), "numerator": 0, "denominator": 0})
            if denominator is None or entry["values"].get(denominator[0]) in denominator[1]:
                group["denominator"] += 1
                entry["roles"].append("denominator")
                if entry["values"].get(numerator[0]) in numerator[1]:
                    group["numerator"] += 1
                    entry["roles"].append("numerator")

    if kind == "aggregate":
        ordered = [groups[key] for key in sorted(groups)]
        # 5. with localcontext()로 전역 Decimal 설정을 건드리지 않은 채 현재 블록에서만 유효 숫자 28자리 정밀도를 적용한다.
        #    _number()는 불필요한 trailing '0'만 제거해 반올림 없이 문자열 비율을 만든다.
        with localcontext() as context:
            context.prec = 28
            for group in ordered:
                group["rate"] = (_number(Decimal(group["numerator"]) / Decimal(group["denominator"]))
                                 if group["denominator"] else None)
        result = {"groups": ordered, "totalRows": len(record_entries), "usedRows": len(used),
                  "excluded": len(record_entries) - len(used), **({"join": joined} if joined else {})}
    else:
        # ... records 모드 반환 형태 구성 생략 ...
        result = {"totalRows": len(record_entries), "usedRows": len(used)}
    return {"result": result, "entries": entries, "limitations": list(dict.fromkeys(limitations))}
```

### 같은 조건 재사용과 불변 기록 저장

두 표까지 합쳐 정확한 비율을 계산했더라도, 여러 사용자가 같은 자료를 다루는 환경에서는 두 가지 문제가 더 남는다. 첫째, 나중에 원본 CSV가 새 버전으로 수정되었을 때 과거에 확정해 둔 계산 결과까지 따라 바뀌면 당시 판단의 근거가 사라진다. 둘째, 여러 담당자가 똑같은 매핑과 필터 조건으로 `5,000`행 규모의 CSV 집계를 요청할 때마다 매번 파일을 다시 읽고 계산하면 서버 자원이 낭비된다.

이 문제를 풀기 위해 DKM은 계산 결과와 당시 조건을 하나의 **불변 계산 기록**으로 저장한다. 요청이 들어오면 같은 조건의 기존 계산 결과를 먼저 찾아 재사용한다. 없을 때만 새로 계산해 저장하는 함수가 `backend/knowledge/evidence/service.py`의 `create_evidence()`다.

1. **사용자가 붙인 근거 이름(`title`)은 빼고 계산 조건만 해시해 재사용하기**: 근거를 생성할 때 사용자는 나중에 구분하기 쉽도록 이름(`title`)을 붙인다. 두 사람이 같은 매핑 버전과 필터 조건으로 집계를 요청하면서 이름만 `"주간 점검"`과 `"긴급 점검"`으로 다르게 적을 수 있다. 이 구분용 이름까지 해시에 넣으면 같은 계산을 두 번 실행하고 내용도 중복 저장된다. 그래서 이름은 빼고 결과를 결정하는 네 가지 입력(분석 모드, 계산 방식 버전, 매핑 버전 목록, 필터 및 결합 조건)만 모아 SHA-256 해시를 만든다. 매핑 버전 ID 안에 원문 CSV 버전과 의미 모델 버전이 이미 연결되어 있으므로, 매핑 ID만 해시에 넣어도 입력 출처가 함께 고정된다. 이때 `None` 값과 빈 배열 `[]`을 미리 제거해야 `"필터를 생략한 요청"`과 `"빈 필터 []를 보낸 요청"`이 같은 해시값으로 일치한다.
2. **무거운 CSV 계산 중에는 DB 행 잠금을 잡지 않고 시작과 끝에서만 짧게 확인하기**: 요청이 들어오면 먼저 짧은 첫 번째 DB 트랜잭션을 연다. 여기서는 같은 `request_id` 재전송이 있는지와 같은 조건 해시의 기존 계산 결과가 있는지부터 조회한다. 이미 완료된 결과가 있으면 `calculate()`를 건너뛰고, DB 행 잠금(`lock=True`)으로 원문 철회 여부와 열람 권한만 확인한 뒤 즉시 반환한다.
   처음 계산하는 경우에만 첫 트랜잭션을 닫고 빠져나와 CSV 행을 읽고 `calculate()`를 실행한다. 수천 행을 파싱하고 집계하는 동안 DB 잠금을 잡고 있으면 다른 사용자의 문서 편집까지 대기 상태에 빠지기 때문이다. 하지만 잠금을 푼 사이에 **관리자 B가 원본 CSV를 철회하거나 권한을 거두었는데, 사용자 A는 그 사실을 모른 채 새 계산 결과를 저장해 버리는 동시성 경합**이 생길 수 있다. 이를 막으려 계산이 끝나면 두 번째 트랜잭션을 열어 원문에 다시 행 잠금을 걸어 철회 여부를 검증한 뒤 결과, 조건, 한계 안내를 하나의 불변 기록으로 저장한다.

```python
# backend/knowledge/evidence/service.py — 계산 조건 해시 재사용과 DB 장시간 잠금을 피하는 2단계 트랜잭션 저장
# - 역할: 계산 요청을 받아 동일 조건의 불변 계산 기록이 있으면 재사용하고, 없으면 계산 후 원문 버전 정보와 함께 영구 저장한다.
# - body: Evidence 생성 요청 DTO (title, kind, mapping_revision_ids, filters/groupBy/join 등 포함)
# - 도우미와 저장소: EvidenceRepository(계산 결과와 멱등 이력 조회 및 저장), require_employee(), utcnow(), digest()(키 정렬 JSON SHA-256 해시)

class EvidenceService:
    # ... __init__(), write_model(), write_mapping(), _require(), _replay(), read(), _source_data(), _meanings() 등 생략 ...

    async def create_evidence(self, principal, body):
        require_employee(principal)
        payload = dict(action='evidence', body=body.public())
        # 1. by_alias=True로 파이썬 스네이크 케이스를 API camelCase JSON 키로 통일하고, None과 빈 배열([])은 지워
        #    '필터 생략'과 'filters=[] 전달'이 동일한 해시(fingerprint)를 갖도록 정규화한다.
        spec = body.model_dump(mode='json', by_alias=True, exclude={'request_id', 'title', 'kind', 'mapping_revision_ids'}, exclude_none=True)
        spec = {key: value for key, value in spec.items() if value != []}
        method = {'aggregate': 'group_rate_v1', 'records': 'mapped_records_v1', 'relation': 'explicit_relation_v1'}[body.kind]

        # 사용자가 붙인 근거 이름(title)은 계산 값을 바꾸지 않으므로 해시에서 빼고, 결과를 결정하는 4가지 입력만 digest()에 넘긴다.
        fingerprint = digest(dict(kind=body.kind, method=method, mappingRevisionIds=body.mapping_revision_ids, conditions=spec))

        async with self.sessions() as session, session.begin():
            repo = EvidenceRepository(session)
            # 2. 같은 request_id로 다시 들어온 요청이면(_replay) replayed=False가 아니라 기존 응답에 replayed=True를 붙여 그대로 반환한다.
            old = await repo.mutation(principal.id, body.request_id, payload)
            if old:
                return await self._replay(session, principal, old)
            # 같은 조건 해시로 완료된 계산 기록이 이미 있으면 원문이 철회되지 않았는지와 읽기 권한을 행 잠금(lock=True)으로 확인한 뒤 재사용한다.
            completed = await repo.snapshot_by_fingerprint(fingerprint)
            if completed:
                await self._require(session, principal, evidence_ids=[completed.id], lock=True)
                result = {**repo.public_snapshot(completed), 'reused': True}
                await repo.remember(principal.id, body.request_id, payload, result)
                return {**result, 'replayed': False}

        # 3. 캐시에 없을 때만 DB 트랜잭션을 닫고 나와 매핑, 모델, CSV 행을 읽고 calculate()를 실행해 DB 행 잠금이 길어지는 현상을 피한다.
        mappings, models, sources = [], {}, {}
        for revision_id in body.mapping_revision_ids:
            mapping = await self.read(principal, 'mapping', revision_id=revision_id)
            mappings.append(mapping)
            if mapping['modelRevisionId'] not in models:
                models[mapping['modelRevisionId']] = await self.read(principal, 'model', revision_id=mapping['modelRevisionId'])
            if mapping['sourceRevisionId'] not in sources:
                sources[mapping['sourceRevisionId']] = await self._source_data(principal, mapping['documentId'], mapping['sourceRevisionId'])

        computed = calculate(body.kind, mappings, models, sources, spec)
        source_inputs = [data['metadata'] for data in sources.values()]
        by_revision = {item['revisionId']: item for item in source_inputs}
        entries = [{**entry, 'sourceKind': 'document', 'documentId': by_revision[entry['sourceRevisionId']]['documentId'],
            'revisionId': entry['sourceRevisionId']} for entry in computed['entries']]

        # 4. 두 번째 트랜잭션에서 멱등성을 다시 확인하고 원문이 그사이 철회되지 않았는지 행 잠금(lock=True)을 걸어 검증한 뒤 불변 기록을 저장한다.
        async with self.sessions() as session, session.begin():
            repo = EvidenceRepository(session)
            old = await repo.mutation(principal.id, body.request_id, payload)
            if old:
                return await self._replay(session, principal, old)
            dependencies = await self._require(session, principal, mapping_revision_ids=body.mapping_revision_ids, lock=True)
            snapshot = dict(title=body.title, kind=body.kind, method=method, methodVersion=1,
                modelRevisionIds=list(models), mappingRevisionIds=body.mapping_revision_ids, sourceRevisionIds=sorted(dependencies),
                inputs=source_inputs, conditions=spec, result=computed['result'], limitations=computed['limitations'],
                meaningRefs=self._meanings(mappings, models, spec), createdAt=utcnow().isoformat())
            row = await repo.save_snapshot(principal.id, fingerprint, snapshot, entries)
            result = repo.public_snapshot(row)
            await repo.remember(principal.id, body.request_id, payload, result)
            return {**result, 'replayed': False}
```

---

## 4. 질문별 요건과 근거 분리

하나의 CSV 계산 결과를 안전하게 저장했더라도, 팀 의사결정 보고서(DKM 내부 위키 문서)에서는 숫자 하나만으로 결론이 나지 않는 경우가 많다. 예를 들어 `"25도에서 발생한 장비 오류를 전면 조사할까, 특정 장비만 다시 점검할까?"`를 정하려면 두 가지 근거를 모두 점검해야 한다. 첫 번째는 `"25도 기준 장비별 초기 불량률이 얼마인가"`이고, 두 번째는 `"같은 시료를 다른 장비에 옮겨 교차 시험한 기록이 있는가"`다. 첫 번째 계산 결과를 문서에 붙였다고 해서 두 번째 확인 항목까지 저절로 채워지지는 않는다.

단순히 위키 문서 끝에 참고 파일 목록만 길게 나열하면 **"지금 무엇은 근거를 찾았고 무엇이 아직 비어 있는가"**가 한눈에 보이지 않는다. 이를 막기 위해 DKM은 위키 의사결정 문서를 최상위 결정, 그 아래 질문(핵심 질문과 세부 질문), 그리고 질문마다 확인해야 할 항목(요건)의 세 계층으로 나눈다(`backend/knowledge/wiki/decision.py`). 확보한 근거는 요건별로 따로 연결한다. 각 요건의 확인 상태는 `'근거 연결'`, `'일부 확인'`, `'미확인'`, `'근거 차이 있음'` 네 가지로 관리한다.

그런데 보고서 작성 도중 전체 판단의 기준 조건이 바뀌면 또 다른 왜곡이 생긴다. 각 판단에는 이 결정이 어느 도메인, 작업 맥락, 시험 조건과 제외 조건에 적용되는지 적어 두는 **조건 범위(condition scope)**가 따른다. 담당자가 처음 문서의 조건 범위를 `25°C`로 정하고 `25°C` 시험 계산 결과를 붙여 첫 번째 요건을 `'근거 연결'` 상태로 확정했다고 가정하자. 그런데 다음 날 회의에서 전체 판단의 기준 조건이 `85°C` 고온으로 바뀌었다. 만약 이미 확인한 하위 요건까지 바뀐 상위 조건(`85°C`)으로 따라 덮어쓰면 문제가 커진다. 막상 열어 보면 `25°C` 데이터로 확인한 기존 근거가 `85°C` 조건에서도 검증된 것처럼 잘못 보이기 때문이다.

3장의 식별 범위가 같은 번호라도 어느 시스템에서 발급됐는지 구분하는 경계였다면, 4장의 조건 범위는 각 요건이 어떤 실험 조건에서 검증되었는지 한정하는 경계다. 상위 결정 조건이 바뀌더라도 이미 확인한 요건의 조건 범위가 따라 덮이지 않게 지켜 주는 함수가 같은 파일의 `freeze_scopes()`다. 전체 위키 결정 계층은 아래 세 가지 원칙으로 기존 검증 근거를 보호한다. (아래 코드 블록에서는 이 중 2번과 상위 조건 비교 로직에 집중해 살펴본다.)

1. **근거 목록이 비어 있으면 상태를 무조건 `'미확인'`으로 출력하기**: 각 요건에는 네 가지 확인 상태가 따로 기록된다. 하지만 위키 문서를 Markdown으로 내보내는 함수는 연결된 근거 목록이 비어 있으면 무조건 `'미확인'`으로 출력한다. 근거가 빠진 항목이 확인된 것처럼 보이지 않게 막기 위해서다.
2. **새 요건에만 상위 조건을 물려주고, 수정 저장 시에는 기존 요건의 조건 유지하기**: 이는 `freeze_scopes()`가 맡는다. 요건을 처음 만들 때만 상위 결정과 질문의 조건 범위를 차례로 상속하고, 각 조건이 어느 계층에서 내려왔는지 함께 기록한다. 이후 문서를 수정할 때 담당자가 그 요건의 조건을 직접 바꾸지 않았으면 기존 범위(`25°C`)를 그대로 지킨다.
   설령 요건의 조건 일부를 직접 고치더라도 새로 바뀐 상위 결정(`85°C`) 대신 기존 요건에 저장되어 있던 조건을 바탕으로 삼아 고친 항목만 반영한다. 이때 Pydantic의 `model_fields_set`으로 `"필드를 아예 생략해 상위 조건을 따르는 경우"`와 `"빈 배열 []을 직접 적어 '조건 제한 없음'으로 상위 제한을 푸는 경우"`를 구분한다. 단순히 값이 비었는지만 보면 `'[]'`이 거짓으로 취급되어, 상위 결정이나 이전 버전에 남아 있던 조건이 그대로 남는 버그가 생긴다.
3. **조건이나 의미 모델 버전이 어긋난 항목은 삭제하지 않고 상태로 경고하기**: 기존 요건의 `25°C` 조건은 그대로 지켜 준다. 대신 현재 상위 결정의 조건(`85°C`)과 어긋난 항목 목록을 따로 계산해 검토 대상으로 알린다. 요건별로 기대하는 의미 모델 정의를 함께 지정해 둔 경우도 마찬가지다. 요건에는 `'측정 온도 정의 v2'` 기준으로 확인하도록 적혀 있는데 연결된 계산 결과는 `'정의 v1'`으로 계산되어 있을 수 있다. 이때도 위키 참조 검증 로직이 기존 근거 링크를 지우지 않고, 요건의 표시 상태만 `'일부 확인'`이나 `'미확인'`으로 낮추어 사람이 다시 검토하게 만든다.

```python
# backend/knowledge/wiki/decision.py — 요건별 조건 범위 고정(freeze_scopes)과 상위 조건 변경 감지
# - 역할: freeze_scopes()는 상위 결정 조건이 바뀌어도 이미 확인한 요건의 조건 범위를 유지해 기존 근거가 오인되지 않게 막고,
#         scope_differences()는 상위 조건과 어긋난 요건 목록을 찾아 검토가 필요한 목록으로 반환한다.
#         (1번 Markdown 출력과 3번의 의미 모델 버전 불일치 검증은 같은 위키 계층의 별도 함수가 맡는다.)
# - DTO / DecisionScope: DKM 공통 Pydantic 기반 스키마 클래스 / 도메인, 작업 맥락, 조건, 제외 항목을 담는 조건 범위 모델
# - self:     저장하려는 현재 위키 결정 DTO(WorkDecisionV2: decision -> question -> requirement 3계층 구조)
# - previous: 수정 이전 버전의 결정 DTO (최초 작성이면 None, 이전 규격 객체가 넘어온 경우 isinstance 검사로 구분)
# - DecisionScope.model_fields_set: Pydantic v2에서 객체 생성 시 실제로 전달된 필드 이름만 담는 집합

class WorkDecisionV2(DTO):
    # ... 필드 선언, graph(), check_references() 등 생략 ...

    def freeze_scopes(self, previous=None):
        """새 요건은 초기 조건을 한 번만 상속하고, 수정하여 다시 저장할 때 기존 요건의 조건 범위를 바꾸지 않는다."""
        # 1. model_copy(deep=True)로 깊은 복사본을 만들어 호출자가 넘긴 원본 객체가 제자리에서 바뀌지 않게 보호한다.
        result = self.model_copy(deep=True)
        # 이전 규격 객체가 넘어온 경우는 제외하고 현행 WorkDecisionV2 목록만 대조한다.
        old = {item.id: item for item in previous.requirements} if isinstance(previous, WorkDecisionV2) else {}

        for requirement in result.requirements:
            earlier = old.get(requirement.id)
            # 2. 이전 버전에도 있던 요건이고 범위 입력이 None이거나 변경 전과 같으면, 기존 조건 범위(earlier.scope)를 그대로 유지한다.
            if earlier and (requirement.scope is None or requirement.scope == earlier.scope):
                requirement.scope = earlier.scope or DecisionScope()
                requirement.scope_sources = dict(earlier.scope_sources)
                continue

            question = next((q for q in result.questions if requirement.id in q.requirement_ids), None)
            layers = [(result.scope, 'decision'), (question.scope if question else None, f'question:{question.id}' if question else 'unspecified')]
            if earlier:
                # 3. 기존 요건을 명시적으로 수정하는 경우에도 새로 바뀐 상위 결정(25°C -> 85°C)은 끌어오지 않고,
                #    기존 요건에 저장되어 있던 조건 범위(earlier.scope)만을 바탕으로 삼는다.
                layers = [(earlier.scope, None)]

            values, origins = {}, dict(earlier.scope_sources) if earlier else {}
            for scope, origin in [*layers, (requirement.scope, 'requirement')]:
                if scope is None:
                    continue
                # 4. scope.model_fields_set으로 '명시적으로 빈 배열 []을 주어 상위 제한을 푼 필드'와 '생략해 상위를 따르는 필드'를 구분한다.
                #    DecisionScope.model_fields[field].alias는 work_context 같은 파이썬 필드명을 API 응답 키('workContext')로 맞춘다.
                for field in scope.model_fields_set:
                    values[field] = getattr(scope, field)
                    if origin:
                        origins[DecisionScope.model_fields[field].alias] = origin

            requirement.scope = DecisionScope(**values)
            # 어느 계층에서도 지정된 적 없는 필드는 'unspecified'로 채워 응답 구조를 일관되게 유지한다.
            requirement.scope_sources = {field.alias: origins.get(field.alias, 'unspecified') for field in DecisionScope.model_fields.values()}
        return result

    def scope_differences(self):
        # 5. 기존 근거를 지키는 대신, 바뀐 상위 조건(self.scope, question.scope)에서 명시적으로 설정된 필드와
        #    고정된 요건(req.scope)이 다른 항목을 모아 검토가 필요한 목록으로 반환한다. (unconfirmed는 아직 확인이 덜 된 상태 표시)
        requirements = {req.id: req for req in self.requirements}
        differences = []
        for question in self.questions:
            values = {}
            for scope in (self.scope, question.scope):
                if scope is not None:
                    values.update({field: getattr(scope, field) for field in scope.model_fields_set})
            for rid in question.requirement_ids:
                req = requirements[rid]
                fields = [DecisionScope.model_fields[field].alias for field, value in values.items()
                          if req.scope is None or getattr(req.scope, field) != value]
                if fields:
                    differences.append({'questionId': question.id, 'requirementId': rid, 'fields': fields,
                                        'unconfirmed': req.scope is None or req.status in ('unconfirmed', 'partial')})
        return differences
```

---

지금까지의 네 단계를 거치면 서론에서 던졌던 `"25도 조건에서 검사 장비별 초기 불량률은 몇 퍼센트인가?"` 같은 질문도 표기 차이나 중복 기록에 흔들리지 않고 재현 가능한 근거를 만들어 답할 수 있다. 먼저 조건 문자열을 십진수로 맞추고 재시험과 중복 첫 시험 기록을 분모에서 빼 정확도를 높였다(`sram.py` `calculate()`). 이어서 파일이 정상 표 형식인지만 보는 단계와 열의 뜻을 연결하는 단계를 분리했다. 미완성 매핑 초안은 저장을 허용하되 실행 가능한 작업 목록(`capabilities`)을 판별해 불완전한 실행을 막을 기준을 만들었다(`validate_mapping()`).

두 표를 합칠 때는 같은 식별 범위와 일대일 대응만 허용해 분모 중복 집계와 부동소수점 오차를 없앴다(`calculation.py` `calculate()`). 같은 계산 조건은 해시로 재사용하고 무거운 계산 중에는 DB 행 잠금을 잡지 않으며 결과를 불변 기록으로 보존했다(`create_evidence()`). 마지막으로 질문마다 확인 항목과 근거를 분리하고, 상위 조건이 `25`도에서 `85`도로 바뀌어도 기존 요건의 조건 범위를 유지했다(`freeze_scopes()`). 덕분에 이미 확인한 근거가 새 조건의 답으로 오인되지 않게 막을 수 있다.

다만 6편에서 다룬 범위는 사용자가 화면이나 API에서 매핑과 계산 조건을 직접 지정해 결과를 만드는 단계다. 사용자가 대화창에 자연어로 조건을 물어보았을 때 질문에서 조건을 추출해 알맞은 표를 고르는 과정이 다음으로 남는다. 실행 시점에 계산 조건을 조립해 넘기고 여러 턴에 걸쳐 조건을 이어 가는 구조는 다음 7편에서 다룬다.
