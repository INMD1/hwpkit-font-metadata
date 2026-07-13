# Hwpkit Font Metadata

한글 폰트의 실제 advance width, 공백 폭, 세로 메트릭과 문자 coverage를 읽어 Hwpkit의 줄바꿈·문단 높이 계산에 사용할 JSON 메타데이터를 만드는 로컬 도구입니다. 원본 폰트를 다른 폰트로 바꿔야 할 때는 후보별 차이와 HWP/HWPX 보정 힌트도 계산합니다.

현재 Hwpkit encoder는 한글을 `1.0em`, 영문 대문자를 `0.65em`, 공백을 `0.32em`으로 보는 고정 폭 모델을 사용합니다. 이 값은 안전한 일반값이지만, 한글 폰트마다 서로 다른 글자 폭·공백 폭·줄 높이를 반영하지 못합니다. 이 프로젝트의 `hwpkit.widthModel`과 `hwpkit.lineModel`은 그 고정값을 폰트별 측정값으로 바꾸기 위한 입력 계약입니다.

이 도구는 HWP/HWPX 파일을 직접 변경하지 않습니다. `hwpkit` 원본소스 본체도 이 프로젝트에서 수정하지 않으며, [examples/hwpkit-consumer.mjs](./examples/hwpkit-consumer.mjs)가 연결 어댑터와 교체 지점을 보여 줍니다.

## 설치

요구 사항은 Node.js 18 이상입니다.

```bash
npm ci
npm run build
node ./dist/bin/hwpkit-font-meta.js --help
```

런타임 분석은 로컬 파일만 읽으며 네트워크로 폰트나 corpus를 전송하지 않습니다.

## 빠른 사용법

폰트 하나를 분석합니다. `-o`를 생략하면 JSON은 표준 출력이 아니라
`./result/analyze-<타임스탬프>.json`에 자동 저장됩니다(자세한 내용은 아래
["결과 저장 위치와 merge"](#결과-저장-위치와-merge) 참고). 표준 출력이 필요하면
`-o -`를 명시적으로 지정하십시오.

```bash
node ./dist/bin/hwpkit-font-meta.js analyze \
  /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc \
  -o ./font-catalog.json
```

파일과 디렉터리를 함께 전달할 수 있습니다. 디렉터리 안의 지원 폰트는 안정적인 순서로 수집되고, 같은 원본 face는 한 번만 기록됩니다.

```bash
node ./dist/bin/hwpkit-font-meta.js analyze \
  ./fonts/Batang.ttf ./fonts/substitutes \
  -o ./all-fonts.json
```

원본 폰트와 대체 후보를 비교합니다. 후보는 적합한 순서대로 `candidates`에 들어가며 coverage가 부족한 후보는 `rejected`에서 이유를 확인할 수 있습니다.

```bash
node ./dist/bin/hwpkit-font-meta.js compare \
  --source ./fonts/Batang.ttf \
  --candidates ./fonts/NotoSerifCJK-Regular.ttc ./fonts/alternatives \
  -o ./font-comparison.json
```

문서 성격에 맞는 corpus를 지정하면 실제 사용 문자열의 shaping 폭이 `layout.samples`와 비교 점수에 반영됩니다.

```bash
node ./dist/bin/hwpkit-font-meta.js analyze ./fonts \
  --corpus ./corpus/legal-forms.txt \
  -o ./legal-fonts.json

node ./dist/bin/hwpkit-font-meta.js compare \
  --source ./fonts/source.ttf \
  --candidates ./fonts/candidates \
  --corpus ./corpus/legal-forms.txt \
  -o ./legal-comparison.json
```

`--corpus`를 생략하면 버전이 고정된 기본 한국어 corpus를 사용합니다. 사용자 corpus는 기본 표본 뒤에 추가되며, `generator.corpusId`는 `hwpkit-ko-layout-v1+custom`으로 표시되고 `generator.corpusSha256`와 layout 값도 달라집니다. 서로 다른 `corpusSha256`로 만든 프로필은 같은 조건의 정밀 비교 자료로 섞지 않는 편이 안전합니다.

## 결과 저장 위치와 merge

`-o`/`--output`을 생략하면 파일명이 `<명령>-<타임스탬프>.json` 형식으로 `./result/`
아래에 자동 저장됩니다.

```bash
node ./dist/bin/hwpkit-font-meta.js analyze ./fonts/본문체.ttf
# → analyze: wrote result/analyze-20260713-185615809.json (0 input error(s))
```

여러 번 `analyze`를 실행해 `result/`에 카탈로그가 여러 개 쌓였다면 `merge`로 하나의
카탈로그로 합칠 수 있습니다. 인자를 생략하면 `./result` 전체를 재귀적으로 훑습니다.

```bash
node ./dist/bin/hwpkit-font-meta.js merge
node ./dist/bin/hwpkit-font-meta.js merge ./result/analyze-a.json ./result/analyze-b.json -o all-fonts.json
```

`merge`는 파일명이 아니라 JSON의 `schemaId`로 대상을 판단합니다. `hwpkit.font-catalog/v1`
문서(`analyze` 결과)만 합쳐지고 `compare` 결과나 그 외 JSON은 조용히 건너뜁니다. 같은
`profileId`를 가진 폰트가 여러 파일에 있으면 먼저 읽은 파일의 것만 채택합니다. 입력
파일은 항상 경로 사전순으로 정렬해서 읽으므로 같은 입력 집합이면 실행할 때마다 같은
결과가 나옵니다.

표준 출력이 필요한 자동화 스크립트라면 세 명령 모두 `-o -`로 파일 저장을 건너뛸 수
있습니다. `result/`는 `.gitignore`에 등록되어 있으므로, 분석 결과를 커밋하려면
`git add -f`로 강제 추가해야 합니다.

코드가 어떻게 구성되어 있고 이 동작을 어디서 바꾸는지는
[HOWTO/00-시작하기.md](./HOWTO/00-시작하기.md)에서 시작하는 문서들을 참고하십시오.

## 명령 계약

### `analyze <font-or-directory...> [-o <file>] [--corpus <file>]`

- `.ttf`, `.otf`, `.ttc`, `.otc`, `.woff`, `.woff2` 중 분석기가 열 수 있는 OpenType 계열 파일을 처리합니다.
- 디렉터리는 재귀적으로 탐색합니다.
- 컬렉션은 face마다 독립 프로필을 생성합니다. 하나만 필요하면 `--face <index-or-name>`을 사용합니다.
- 일부 파일을 읽지 못해도 성공한 프로필은 `fonts`에 남고 실패 항목은 `errors`에 남습니다. 기본 모드는 부분 성공 시 0으로 종료하므로 자동화에서는 `--strict`를 사용하거나 `errors.length`를 확인하십시오.
- `--max-files`와 `--max-file-size-mib`로 대량 입력과 비정상적으로 큰 파일을 제한할 수 있습니다.
- `-o`를 생략하면 `./result/analyze-<타임스탬프>.json`에 저장됩니다. `-o -`는 표준 출력을 강제합니다.
- 출력은 `schema/font-catalog.schema.json`의 `hwpkit.font-catalog/v1` 계약을 따릅니다.

### `compare --source <font> --candidates <font-or-directory...> [-o <file>] [--corpus <file>]`

- source가 컬렉션이고 여러 face가 있으면 명령이 중단됩니다. `--source-face <index-or-name>`으로 하나를 선택하십시오. 후보 collection은 기본적으로 모든 face를 비교하며 `--candidate-face`로 제한할 수 있습니다.
- 후보의 가로 폭, 공백, 세로 메트릭, 스타일 속성과 필수 한글 coverage를 비교합니다.
- 점수는 편의를 위한 상대 순위입니다. `score`만 보지 말고 `coverage`, `components`, `deltas`, `adjustments`를 함께 확인하십시오.
- `--top <count>`는 적합 후보 출력 수를 제한하고, `--strict`는 입력 오류가 하나라도 있으면 비정상 종료합니다.
- `-o`를 생략하면 `./result/compare-<타임스탬프>.json`에 저장됩니다. `-o -`는 표준 출력을 강제합니다.
- 출력은 `schema/font-comparison.schema.json`의 `hwpkit.font-comparison/v1` 계약을 따릅니다.

### `merge [json-or-directory...] [-o <file>]`

- `analyze`가 만든 `hwpkit.font-catalog/v1` 카탈로그 JSON 여러 개를 하나로 합칩니다. 인자를 생략하면 `./result`를 재귀적으로 스캔합니다.
- 대상 판단은 파일명이 아니라 JSON의 `schemaId`로 합니다. 일치하지 않는 파일(예: `compare` 결과)은 조용히 건너뜁니다.
- 같은 `profileId`가 여러 파일에 있으면 경로 사전순으로 먼저 읽힌 파일의 항목을 채택합니다.
- `-o`를 생략하면 `./result/merged-<타임스탬프>.json`에 저장됩니다. `-o -`는 표준 출력을 강제합니다.
- 출력은 `analyze`와 동일하게 `schema/font-catalog.schema.json`의 `hwpkit.font-catalog/v1` 계약을 따릅니다.

경로에 공백이 있으면 셸에서 따옴표로 감쌉니다.

```bash
node ./dist/bin/hwpkit-font-meta.js analyze "/opt/company fonts/본문체.otf" -o catalog.json
```

## TTC/OTC 컬렉션

TTC/OTC 한 파일에는 여러 family 또는 weight face가 들어갈 수 있습니다. 따라서 파일 SHA-256만으로 폰트를 식별하면 충분하지 않습니다. 이 도구는 모든 face를 순회하여 다음과 같이 구분합니다.

```json
{
  "profileId": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef#face=2",
  "source": {
    "fileName": "ExampleCollection.ttc",
    "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "faceIndex": 2,
    "faceCount": 10
  },
  "face": {
    "family": "Example Sans KR",
    "subfamily": "Bold"
  }
}
```

Hwpkit에서 lookup할 때는 `family`만 사용하지 말고 가능한 한 `profileId`를 저장하십시오. 파일이 갱신되면 SHA-256이 달라져 예전 측정값을 실수로 재사용하지 않게 됩니다. 이름으로 찾아야 한다면 family, subfamily, weight, italic과 `faceIndex`를 함께 검사해야 합니다.

## 메타데이터 읽기

카탈로그 최상위에는 다음 필드가 있습니다.

| 필드 | 의미 |
| --- | --- |
| `schemaVersion` / `schemaId` | 소비자가 호환성을 판단하는 버전과 문서 종류 |
| `generator` | 분석기·파서·shaper 버전과 corpus 식별자 |
| `fonts` | 파일의 각 face를 분석한 `hwpkit.font-profile/v1` 배열 |
| `errors` | 열 수 없거나 분석할 수 없었던 입력. 폰트 바이너리는 포함하지 않음 |

각 font profile의 핵심 필드는 다음과 같습니다.

| 필드 | 의미와 Hwpkit 사용처 |
| --- | --- |
| `profileId` | `sha256:<file hash>#face=<index>` 형식의 불변 식별자 |
| `source` | 파일명, 크기, SHA-256, 컨테이너 형식, collection face 위치. 로컬 경로는 기록하지 않음 |
| `face` | family/subfamily/PostScript 이름, 굵기·장평 class, italic/monospace, variable axis |
| `coverage.sets` | 현대 한글 음절, 자모, 한자, 라틴 등 probe 집합별 `required`, `mapped`, `missing`, `ratio` |
| `coverage.missingSamples` | 빠진 문자 일부. 전체 cmap 덤프가 아니라 진단용 표본 |
| `metrics.unitsPerEm` | OpenType font unit을 em으로 나누는 기준 |
| `metrics.raw` | `head`, `hhea`, `OS/2` 표에서 읽은 원시 font-unit 값 |
| `metrics.line` | typo/hhea/Windows 세로 메트릭과 실제 선택된 `preferred` line box |
| `metrics.advance` | 문자군별 advance 통계. `unit`은 `em`이므로 폰트 크기에 바로 곱할 수 있음 |
| `metrics.ink` | 글리프의 advance가 아닌 실제 잉크 경계 표본. 잘림·상하 여백 판단 보조값 |
| `metrics.glyphs` | 제한된 probe 문자의 glyph id, raw advance와 em advance |
| `layout.samples` | shaping을 적용한 문장별 hash, glyph 수, 누락, 전체 폭. 원문 대신 `textSha256`를 기록하며 kerning/조합 차이를 비교할 때 사용 |
| `hwpkit.widthModel` | encoder가 빠르게 문자 폭을 추정하도록 축약한 `*Em` 계수 |
| `hwpkit.lineModel` | line height, baseline, ascender/descender를 HWPUNIT으로 바꾸기 위한 em 계수 |
| `hwpkit.visualModel` | 한글 ink 폭·높이·상하 경계·side bearing 표본. 같은 advance라도 작거나 크게 보이는 후보를 판별하는 보조값 |
| `hwpkit.confidence` | coverage와 유효 표본 수를 반영한 `high`/`medium`/`low` 등급. 낮으면 고정 fallback과 실제 렌더 검증 필요 |
| `quality` | 분석 상태와 경고. 필드가 존재한다고 해서 모든 표본의 신뢰도가 같다는 뜻은 아님 |

### raw와 em을 혼동하지 않기

`metrics.raw`와 `advanceDu` 값은 폰트의 고유 design unit입니다. 예를 들어 `unitsPerEm=2048`, `advanceDu=1024`이면 폭은 `0.5em`입니다. 10pt 글자에서는 약 5pt이고, HWPUNIT으로는 약 500입니다.

```text
advanceEm  = advanceDu / unitsPerEm
fontHwp    = fontPt × 100
advanceHwp = round(advanceEm × fontHwp)
```

Hwpkit의 `Metric.ptToHwp()`가 이미 pt→HWPUNIT 변환을 담당하므로 소비 코드에서 다시 100을 곱하지 마십시오.

### width model

`hwpkit.widthModel`은 다음 계수를 가집니다.

- `hangulEm`: 완성형 한글 음절
- `jamoEm`: 현대 자모와 호환 자모 표본의 평균
- `hanjaEm`: 문서에서 자주 쓰는 `commonHanja` 표본의 평균이며 전체 CJK 평균은 아님
- `latinUpperEm`, `latinLowerEm`, `digitEm`: ASCII 영문 대/소문자와 숫자
- `spaceEm`: 일반 공백
- `punctuationEm`: 문장부호 표본
- `bodyTextEm`: 위 범주에 속하지 않는 본문 문자의 보수적 fallback

이 값은 빠른 line cache 계산용 대표값입니다. 실제 OpenType shaping은 문자쌍 kerning, ligature, combining mark, variation axis에 따라 달라질 수 있으므로 최종 렌더러와 완전히 같은 폭을 보장하지는 않습니다.

## Hwpkit 연결 예

먼저 카탈로그를 만들고 예제 어댑터를 실행합니다.

```bash
node ./dist/bin/hwpkit-font-meta.js analyze ./fonts/본문체.ttf -o ./font-catalog.json
node ./examples/hwpkit-consumer.mjs \
  ./font-catalog.json "본문체" "한글 ABC 123 문단입니다." 10
```

코드에서는 profile을 한 번 선택한 뒤 문단 loop 밖에서 adapter를 재사용합니다.

```js
import {
  loadFontCatalog,
  selectFontProfile,
  createHwpkitFontAdapter,
} from './examples/hwpkit-consumer.mjs';

const catalog = await loadFontCatalog('./font-catalog.json');
const profile = selectFontProfile(catalog, { family: '본문체' });
const fontMetrics = createHwpkitFontAdapter(profile);

const fontHwp = 10 * 100;
const charWidth = fontMetrics.codePointWidthHwp('한'.codePointAt(0), fontHwp);
const starts = fontMetrics.lineStartPositionsHwp(
  '폰트에 맞춰 줄바꿈 위치를 계산합니다.',
  fontHwp,
  12000,
);

// 선택 폰트에 없는 계수는 기존 encoder 상수로 보완됩니다.
console.log(fontMetrics.fallbackKeys);
```

현재 본체에서 연결할 지점은 다음 세 곳입니다.

1. `runner/src/encoders/hwp/HwpEncoder.ts`의 `estimateCharWidthHwp()`에서 Unicode 범위별 상수를 adapter의 `codePointWidthHwp()` 결과로 교체합니다.
2. `runner/src/encoders/hwpx/HwpxEncoder.ts`의 `buildLinesegarray()` 문자 폭 분기에서 같은 adapter를 사용합니다.
3. 같은 `HwpxEncoder.ts`의 `estimateLineCountForWidth()`에도 반드시 같은 폭 resolver를 전달합니다. 두 경로가 서로 다른 계수를 쓰면 표 높이 계산과 실제 `linesegarray`가 어긋납니다.

세로 계산도 적용하려면 기존 사용자의 명시적 `lineHeightFixed`/`lineHeight`를 우선하고, 값이 없을 때만 `lineAdvanceHwp()`와 `baselineHwp()`를 fallback으로 쓰는 방식이 안전합니다. HWPX의 `<hh:ratio>`, `<hh:spacing>`, `<hh:relSz>`는 별도 글자 모양 속성이므로 `advanceEm`을 그대로 해당 XML 백분율에 쓰면 안 됩니다.

성능상 JSON을 문자마다 읽거나 family 이름을 매번 검색하지 마십시오. 문서 변환 시작 시 카탈로그를 한 번 읽고 `(sha256, faceIndex)` 또는 정규화한 face 이름으로 adapter를 캐시하는 구성이 적절합니다.

## 비교 결과와 보정값

`compare` 결과의 `distance`는 작을수록 원본에 가깝고 `score`는 클수록 대체 후보로 적합합니다. `components`는 차이를 다음 네 축으로 나눕니다.

- `width`: 한글·자모·한자·라틴·숫자의 대표 advance와 corpus 문장 폭
- `space`: 일반 공백 및 공백류의 차이
- `vertical`: line height와 baseline 차이
- `style`: weight class, width class, italic 같은 face 속성 차이

`adjustments.hwp`와 `adjustments.hwpx`는 자동 적용 명령이 아니라 보정 힌트입니다. 장평, 자간, 줄 간격은 HWP와 HWPX에서 저장 단위와 반올림 방식이 다르고, 큰 보정은 글자 모양 자체를 훼손할 수 있습니다. 보정 후에는 HWP/HWPX를 실제 한컴오피스 또는 목표 렌더러로 열어 페이지 수, 표 셀 overflow, 문단 마지막 줄을 확인해야 합니다.

## 스키마와 버전 정책

- [schema/font-catalog.schema.json](./schema/font-catalog.schema.json): `analyze` 카탈로그와 내부 font profile 정의
- [schema/font-comparison.schema.json](./schema/font-comparison.schema.json): `compare` 순위·차이·보정 정의
- `schemaId`가 다르면 다른 문서 종류입니다.
- `schemaVersion`의 major가 다르면 소비자는 처리를 중단해야 합니다.
- 모르는 minor 필드는 무시할 수 있지만, encoder에 사용하는 필수 계수가 없으면 임의로 0을 쓰지 말고 기존 Hwpkit 고정값으로 fallback해야 합니다.

재현 가능한 출력을 위해 생성 시간과 입력 절대 경로는 기록하지 않습니다. profile 정렬, object key 정렬, SHA-256, corpus 버전을 고정하여 같은 도구 버전·같은 입력에서 같은 JSON을 얻는 것을 목표로 합니다.

## 상용 폰트와 보안

상용·기관 전용 폰트는 다음 원칙으로 다루십시오.

- 폰트 라이선스가 허용하는 장비와 사용자 계정에서만 분석하십시오. 이 도구가 로컬에서 동작한다는 사실이 복제·변환·서버 사용 권한을 부여하지는 않습니다.
- 원본 `.ttf/.otf/.ttc` 파일을 저장소, CI artifact, 이슈 또는 메신저에 첨부하지 마십시오. `.gitignore`에 분석 대상 폰트 디렉터리를 별도로 추가하는 것이 좋습니다.
- 카탈로그에는 글리프 outline이나 폰트 바이너리가 들어가지 않지만, 파일명·face 이름·SHA-256과 custom corpus의 hash·파생 폭은 조직 내부 정보를 드러낼 수 있습니다. 외부 공유 전에 JSON도 검토하십시오.
- 민감 문서를 그대로 `--corpus`에 넣지 마십시오. 필요한 문자 분포를 보존한 비식별 예문을 쓰십시오. corpus 원문과 파일 경로는 기록하지 않지만 `textSha256`와 layout 통계는 식별 단서가 될 수 있습니다.
- 신뢰하지 않는 폰트는 별도 컨테이너와 CPU/메모리 제한 안에서 분석하십시오. 폰트 파서는 복잡한 바이너리를 처리하며, 이 CLI 자체는 악성 폰트를 격리하는 sandbox가 아닙니다.
- 분석 결과는 폰트 저작권·라이선스에 관한 법률 판단이 아닙니다. 배포 가능 여부는 해당 EULA와 조직 정책을 확인하십시오.

## 알려진 제약

- 메트릭 분석은 실제 한컴오피스의 글꼴 대체, hinting, rasterizer 반올림을 완전히 재현하지 않습니다.
- 대표 width model은 속도용 근사입니다. 최종 행갈이는 shaping된 glyph run을 사용해야 가장 정확합니다.
- variable font는 기본 axis 위치의 profile을 기준으로 합니다. 문서가 다른 `wght`, `wdth`, `opsz` 값을 사용하면 별도 instance 분석이 필요합니다.
- 세로쓰기, ruby, 조판부호 압축, 양쪽 정렬의 공간 재분배, OpenType language별 feature는 현재 보정 모델 밖입니다.
- Unicode coverage가 높아도 글리프 디자인 품질이나 원본과의 시각적 유사성이 높다는 뜻은 아닙니다.
- `quality.status`가 정상이어도 HWP/HWPX 변환의 최종 판정은 렌더 비교로 해야 합니다.

## 개발 확인

```bash
cd runner/font-metadata
npm test
node --check ./examples/hwpkit-consumer.mjs
```

fixture 폰트는 재배포 가능한 라이선스의 작은 파일만 저장소에 포함하고, 상용 폰트 경로에 의존하는 테스트는 만들지 마십시오.
