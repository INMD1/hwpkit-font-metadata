# `compare`는 어떻게 동작하나

`compare`는 원본 폰트 하나(source)와 후보 폰트 여러 개(candidates)를 분석한 뒤,
각 후보가 원본과 얼마나 비슷한지 점수를 매깁니다. `analyze`가 폰트 "하나"를 분석하는
도구라면, `compare`는 그 결과 두 개를 "비교"하는 도구입니다.

## 전체 흐름

```
bin/hwpkit-font-meta.ts : runCompare()
  1. source, candidates를 각각 loadWithLimits() + analyzeFontSources()로 분석
     (이 부분은 analyze와 완전히 같은 코드를 재사용한다 — 01번 문서 참고)
  2. rankFontCandidates(sourceProfile, candidates)   (src/compare.ts)
       for 각 candidate:
         checkCoverageCompatibility()   -- 한글 coverage가 너무 부족하면 탈락(하드 게이트)
         compareFontProfiles()          -- 통과한 후보만 거리(distance)/점수(score) 계산
       탈락한 후보 → result.rejected, 통과한 후보 → result.candidates (점수순 정렬)
  3. writeJson()으로 result/ 또는 -o로 저장
```

## 왜 "coverage 체크"가 먼저 나오나

`src/compare.ts`의 `checkCoverageCompatibility()`(346번째 줄)는 후보 폰트에 현대
한글 음절이 충분히 있는지를 먼저 확인합니다. 여기서 떨어지면 그 후보는 **거리/점수를
아예 계산하지 않고** `rejected` 목록으로 빠집니다. 글자가 없는 폰트에 억지로 점수를
매기는 건 의미가 없기 때문입니다. 이 기준을 완화/강화하고 싶다면 이 함수와
`ComparisonOptions.minimumCoverageRatio`를 보세요.

## 점수는 어떻게 계산되나 — `compareFontProfiles()`

코드 906번째 줄 근처. 두 프로필의 차이를 네 가지 축으로 나눠서 각각 거리(distance)를
구하고, 가중합으로 합칩니다.

| 축(component) | 담당 함수 | 가중치 상수 |
| --- | --- | --- |
| `width` (한글/자모/한자/라틴/숫자 폭) | `extractWidthModel()` + `metricComponent()` | `DEFAULT_WIDTH_METRIC_WEIGHTS` |
| `space` (공백류 폭) | `extractSpaceAdvance()` | `DEFAULT_COMPONENT_WEIGHTS.space` |
| `vertical` (줄 높이/베이스라인) | `extractLineModel()` + `metricComponent()` | `DEFAULT_VERTICAL_METRIC_WEIGHTS` |
| `style` (weight/width class, italic) | `extractStyle()` + `styleComponent()` | `DEFAULT_STYLE_METRIC_WEIGHTS` |

네 축의 최종 합산 비율은 `DEFAULT_COMPONENT_WEIGHTS`
(`width 0.62 / space 0.16 / vertical 0.17 / style 0.05`)로 정해져 있습니다. **이 값들이
바로 "어떤 요소를 더 중요하게 볼지"를 결정하므로, 점수의 우선순위를 바꾸고 싶다면
가장 먼저 여기를 봐야 합니다.**

각 축의 거리는 `weightedTotal()`이 개별 metric 거리를 가중 평균해서 만들고, 최종
`distance`는 네 축을 다시 가중 평균한 값입니다. `score`는 `distance`를 사람이 읽기
좋은 방향(클수록 좋음)으로 뒤집은 값이라고 생각하면 됩니다. **중요:** 이 거리 계산은
후보 목록 전체를 보고 상대적으로 정규화하지 않습니다. 후보가 한 개든 열 개든 같은
입력이면 같은 distance가 나옵니다(파일 상단 주석 참고). 그래서 후보를 나중에 추가해도
기존 후보들의 점수는 절대 바뀌지 않습니다.

## `adjustments.hwp` / `adjustments.hwpx`는 무엇인가

`computeFormatAdjustments()`(748번째 줄)가 만듭니다. 장평(ratio)·자간(spacing) 보정치를
HWP/HWPX가 저장할 수 있는 정수 백분율로 계산해 주는데, `DEFAULT_ADJUSTMENT_LIMITS`
(기본 `ratio: 95~105`, `spacing: -2~2`)를 절대 벗어나지 않도록 `clamp()`로 잘라냅니다.
이 한계를 넓히려면 CLI에 옵션을 추가하고 `ComparisonOptions.adjustmentLimits`로 전달하면
되지만, README에도 적혀 있듯이 큰 보정은 글자 모양 자체를 훼손할 수 있으므로 신중하게
접근해야 합니다.

## 후보를 순위로 만들기 — `rankFontCandidates()`

`src/compare.ts` 956번째 줄. `checkCoverageCompatibility()` → `compareFontProfiles()`를
후보마다 반복 호출하고, 통과한 후보를 `score` 내림차순(동점이면 `profileId` 오름차순으로
`ranking uses profileId as a deterministic tie breaker` 테스트가 보장)으로 정렬합니다.
CLI의 `--top <n>` 옵션은 이 정렬된 배열을 자른 것뿐입니다(`bin/hwpkit-font-meta.ts`의
`runCompare()`).

## 결과 JSON 구조 요약

```
{
  schemaId: "hwpkit.font-comparison/v1",
  source: { ... },        // 원본 요약
  candidates: [ ... ],     // 통과 + score순 정렬
  rejected: [ ... ],       // coverage 미달 사유 포함
  errors: [ ... ]
}
```

정식 구조는 [../schema/font-comparison.schema.json](../schema/font-comparison.schema.json)에
있습니다.
