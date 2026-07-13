# `analyze`는 어떻게 동작하나

`hwpkit-font-meta analyze <font...>`를 실행했을 때 코드가 어떤 순서로 움직이는지
파일과 함수 단위로 따라가 봅니다.

## 전체 흐름

```
bin/hwpkit-font-meta.ts : runAnalyze()
  1. loadCorpusSamples()        -- 사용자가 --corpus로 준 예문을 읽는다 (src/analyze.ts 아님, bin 안에 있음)
  2. loadWithLimits()           -- 입력 경로를 폰트 파일 목록으로 펼치고, 개수/용량 제한을 적용
       └─ discoverFontFiles()    (src/font-source.ts)  경로 → 실제 폰트 파일 절대경로 목록
       └─ loadFontSources()      (src/font-source.ts)  파일을 읽어 fontkit으로 열고 SHA-256을 계산
  3. analyzeFontSources()        (src/analyze.ts)       각 폰트 face를 하나씩 analyzeFontSource()로 분석
  4. createCatalog()             (src/analyze.ts)       분석된 fonts[] + errors[] 를 카탈로그 JSON으로 포장
  5. writeJson()                 (bin/hwpkit-font-meta.ts) result/ 또는 -o 로 지정한 파일에 저장
```

## 1단계 — 폰트 파일 찾기: `src/font-source.ts`

- `discoverFontFiles(inputs)`: 사용자가 넘긴 파일/디렉터리 경로들을 재귀적으로 훑어서
  `.ttf/.otf/.ttc/.otc/.woff/.woff2` 파일만 골라냅니다. 심볼릭 링크나 중복 경로는
  `realpath`로 정규화해서 한 번만 세도록 되어 있습니다.
- `loadFontSources(files)`: 각 파일을 읽어(`fs.readFile`) SHA-256을 계산하고, `fontkit`
  라이브러리(`createFont`)로 열어서 `FontSource` 객체를 만듭니다. TTC/OTC처럼 폰트
  하나에 여러 face(폰트 모음)가 들어있으면 face마다 별도의 `FontSource`가 됩니다.
- 여기서 실패한 파일(깨진 폰트, 권한 오류 등)은 예외를 던지지 않고 `errors` 배열에
  기록되어 다른 파일 분석을 막지 않습니다. "부분 성공"이 기본 동작입니다.

## 2단계 — 폰트 하나 분석하기: `src/analyze.ts`의 `analyzeFontSource()`

이 함수(860번째 줄 근처)가 이 프로젝트의 핵심입니다. `FontSource` 하나를 받아서
`FontProfile` 하나를 돌려줍니다. 내부적으로 여러 개의 "추출기" 함수를 순서대로 부릅니다.

| 무엇을 뽑나 | 담당 함수 | 결과가 들어가는 필드 |
| --- | --- | --- |
| 문자 coverage(글자가 있는지 없는지) | `extractCoverage()` | `coverage` |
| 문자군별 폭 통계(평균/중앙값 등) | `extractAdvanceMetrics()` | `metrics.advance` |
| 줄 높이/베이스라인 | `extractLineMetrics()` | `metrics.line` |
| 한글 잉크(실제로 그려지는 범위) 여백 | `extractInkMetrics()` | `metrics.ink` |
| 대표 글자 몇 개의 glyph 정보 | `extractRepresentativeGlyphs()` | `metrics.glyphs` |
| 실제 문장을 shaping해서 폭 재기 | `layoutMetrics()` → `shapeSample()` | `layout.samples` |
| family/굵기/기울임 등 face 속성 | `faceMetadata()` | `face` |
| 위 결과들을 Hwpkit이 쓰기 쉬운 계수로 축약 | `buildHwpkitProfile()` | `hwpkit` |

모든 "폭" 관련 함수는 `GlyphReader`(`createGlyphReader()`가 만듦)를 통해 glyph를
읽습니다. 이 reader는 내부에 캐시(`Map`)를 갖고 있어서 같은 코드포인트를 여러 번
물어봐도 fontkit을 한 번만 호출합니다. **새로운 문자 집합을 추가로 측정하고 싶다면
이 reader의 `read(codePoint)`를 그대로 재사용하세요.**

### `hwpkit` 필드가 특별한 이유

다른 필드(`coverage`, `metrics`, `layout`)는 "측정 결과를 있는 그대로" 담습니다.
반면 `hwpkit` 필드(`buildHwpkitProfile()`, 703번째 줄)는 그 측정값들을 Hwpkit
encoder가 바로 곱셈에 쓸 수 있는 소수 몇 개(`widthModel`, `lineModel`,
`visualModel`)로 요약합니다. 이 요약 로직을 바꾸면 Hwpkit이 실제로 계산하는
줄바꿈 결과가 바뀌므로, 여기를 고칠 때는 README의 "width model" 절도 같이
업데이트해야 합니다.

## 3단계 — 여러 폰트를 모아서 정렬: `analyzeFontSources()`

`src/analyze.ts` 959번째 줄. 폰트 소스 목록을 순회하며 하나씩
`analyzeFontSource()`를 부르고, 실패하면 `errors`에 기록합니다. 마지막에
`sortFontProfiles()`로 정렬하는데, 정렬 기준은 "family 이름(한국어 로케일) →
파일 SHA-256 → face 순서"입니다. **이 정렬은 출력 JSON을 항상 같은 순서로 만들기
위한 것**이므로, 같은 입력이면 언제 실행해도 같은 결과가 나와야 한다는 이 프로젝트의
원칙(README "스키마와 버전 정책" 절)과 연결되어 있습니다. `sortFontProfiles()`는
[03-출력관리와-merge.md](./03-출력관리와-merge.md)에서 설명하는 `merge` 명령에서도
그대로 재사용됩니다.

## 4단계 — 카탈로그로 포장: `createCatalog()`

`src/analyze.ts` 978번째 줄. `fonts` 배열과 `errors` 배열을 받아서 최상위에
`schemaVersion`, `schemaId`(`hwpkit.font-catalog/v1`), `generator` 정보를 붙인
최종 JSON 모양을 만듭니다. 이 JSON의 정식 구조는
[../schema/font-catalog.schema.json](../schema/font-catalog.schema.json)에 정의되어
있습니다.

## 5단계 — 파일로 저장

`bin/hwpkit-font-meta.ts`의 `runAnalyze()`가 `writeJson()`을 호출합니다. `-o` 옵션을
줬는지 여부에 따라 어디에 저장할지가 달라지는데, 이 부분은
[03-출력관리와-merge.md](./03-출력관리와-merge.md)에서 자세히 다룹니다.

## corpus(예문)는 어디서 들어오나

`--corpus <file>`로 준 텍스트 파일은 `analyze.ts`가 아니라 `bin/hwpkit-font-meta.ts`의
`loadCorpusSamples()`가 읽습니다. 여기서 줄 단위로 잘라 `LayoutSample[]`을 만들고,
`analyzeFontSources(sources, { corpusSamples })`로 넘겨줍니다. `src/analyze.ts`는
이 샘플들을 `constants.ts`의 `DEFAULT_LAYOUT_SAMPLES`(기본 예문)와 합쳐서
`layoutMetrics()`에 넘길 뿐, 파일을 직접 읽지 않습니다.
