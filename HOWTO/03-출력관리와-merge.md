# 출력(-o) 기본 동작과 `merge` 명령

이 문서는 새로 추가된 두 기능을 설명합니다.

1. `-o/--output`을 주지 않으면 JSON을 화면(stdout)이 아니라 `result/` 폴더에 자동으로
   저장한다.
2. `result/`에 쌓인 여러 `analyze` 결과 JSON을 하나로 합치는 `merge` 명령.

관련 코드는 전부 `bin/hwpkit-font-meta.ts` 한 파일 안에 있습니다.

## 1. `-o` 없이 실행하면 어디에 저장되나

```bash
node ./dist/bin/hwpkit-font-meta.js analyze ./fonts/본문체.ttf
# → analyze: wrote result/analyze-20260713-185615809.json (0 input error(s))
```

파일 이름 규칙은 `<명령어>-<타임스탬프>.json`입니다. 타임스탬프는
`YYYYMMDD-HHmmssSSS`(연월일-시분초밀리초) 형태라서 같은 초에 여러 번 실행해도 파일명이
겹치지 않습니다.

| 명령 | 기본 저장 위치 |
| --- | --- |
| `analyze` | `result/analyze-<timestamp>.json` |
| `compare` | `result/compare-<timestamp>.json` |
| `merge` | `result/merged-<timestamp>.json` |

구현은 `bin/hwpkit-font-meta.ts`의 두 함수입니다.

```ts
function timestampSlug(date: Date): string { ... }          // 388번째 줄
function defaultOutputPath(prefix: string): string { ... }  // 397번째 줄
  // return path.join(RESULT_DIR, `${prefix}-${timestampSlug(new Date())}.json`);
```

그리고 각 명령의 실행 함수(`runAnalyze`, `runCompare`, `runMerge`)는 다음과 같은
한 줄짜리 패턴을 씁니다.

```ts
const outputPath = options.output ?? defaultOutputPath("analyze");
await writeJson(catalog, outputPath, options.pretty, loaded.files);
```

즉 `options.output`이 `null`(=`-o`를 안 줌)일 때만 기본 경로를 계산합니다. `-o`로 직접
경로를 주면 예전과 완전히 동일하게 그 경로에 저장됩니다.

### 여전히 화면 출력이 필요하다면

자동화 스크립트에서 파일을 만들지 않고 JSON을 파이프로 바로 받고 싶다면
`-o -` 또는 `--output -`를 명시적으로 주세요. `writeJson()`은 `"-"`를 stdout으로
취급합니다(이 동작은 이번 변경 이전부터 있던 기존 규칙입니다).

```bash
node ./dist/bin/hwpkit-font-meta.js analyze ./fonts -o - | jq .fonts[0].profileId
```

### `result/` 폴더 이름이나 파일명 규칙을 바꾸고 싶다면

- 폴더 이름: `bin/hwpkit-font-meta.ts` 맨 위쪽의 `const RESULT_DIR = "result";`만 고치면
  `analyze`/`compare`/`merge` 세 명령 전부에 반영됩니다.
- 파일명 규칙: `defaultOutputPath()` 함수 하나만 고치면 됩니다. 단, `merge`는 **이름이
  아니라 파일 내용의 `schemaId`로 대상을 판단**하므로(아래 참고) 파일명 규칙을 바꿔도
  merge 동작에는 영향이 없습니다.
- `result/`는 `.gitignore`에 이미 등록돼 있습니다. 분석 결과를 커밋하고 싶다면 해당
  줄을 지우거나 필요한 파일만 `git add -f`로 강제 추가하세요.

## 2. `merge` 명령

여러 번 `analyze`를 돌려서 `result/`에 JSON이 여러 개 쌓였을 때, 이걸 하나의 카탈로그로
합치는 명령입니다.

```bash
# 인자 없이: result/ 폴더 전체를 재귀적으로 훑어서 merge
node ./dist/bin/hwpkit-font-meta.js merge

# 특정 파일/폴더만 지정
node ./dist/bin/hwpkit-font-meta.js merge ./result/analyze-a.json ./result/analyze-b.json -o all-fonts.json

# 여러 프로젝트의 result 폴더를 한 번에
node ./dist/bin/hwpkit-font-meta.js merge ./team-a/result ./team-b/result
```

### 내부 동작 순서 (`bin/hwpkit-font-meta.ts`)

```
parseMerge(args)              -- 496번째 줄. 인자가 없으면 inputs = ["result"]로 기본값 설정
runMerge(options)              -- 616번째 줄
  1. collectMergeInputFiles()  -- 534번째 줄. 각 입력을 stat()해서 폴더면 walkJsonFiles()로
                                   재귀 탐색, 파일이면 그대로 사용. *.json만 모음
  2. readJsonFile()            -- 552번째 줄. 각 파일을 읽고 JSON.parse
  3. mergeFontCatalogs(inputs) -- 577번째 줄. 실제 합치기 로직 (아래 참고)
  4. defaultOutputPath("merged") 또는 -o 로 저장
```

### 합치기 규칙 — `mergeFontCatalogs()`

이 함수는 파일 시스템을 전혀 건드리지 않는 순수 함수라서 테스트하기 쉽고
(`test/cli.test.mjs` 참고), 로직을 바꾸고 싶을 때 여기만 보면 됩니다.

- **어떤 파일을 인정하나**: JSON의 최상위 `schemaId`가
  `CATALOG_SCHEMA_ID`(`"hwpkit.font-catalog/v1"`, `src/constants.ts`)와 같고 `fonts`가
  배열인 경우에만 "카탈로그 파일"로 인정합니다. `compare` 결과(`schemaId`가
  `hwpkit.font-comparison/v1`)나 다른 JSON은 조용히 건너뛰고 `stats.skippedFiles`에
  기록합니다. 즉 **파일명이 아니라 내용으로 판단**합니다.
- **중복 처리**: 폰트 하나하나를 구분하는 값은 `profileId`
  (`sha256:<파일해시>#face=<번호>`)입니다. 여러 파일에 같은 `profileId`가 있으면
  **먼저 읽은 파일의 것**을 채택하고 이후 것은 버리며 `stats.duplicateFontCount`를
  올립니다. 입력 파일은 항상 경로 사전순으로 정렬해서 읽으므로(`collectMergeInputFiles()`
  의 `.sort()`), 이 "먼저"는 실행할 때마다 달라지지 않습니다.
- **`errors` 배열**: 각 파일의 `errors`도 합쳐지는데, `JSON.stringify()`한 값이 완전히
  같은 항목은 한 번만 남깁니다(파일을 실수로 두 번 넣어도 에러가 중복되지 않게).
- **정렬**: 합쳐진 `fonts`는 `analyze`가 카탈로그를 만들 때와 똑같은 기준
  (`sortFontProfiles()`, `src/analyze.ts`)으로 정렬됩니다. 그래서 `analyze` 한 번으로
  만든 카탈로그와 `merge`로 합친 카탈로그는 순서 규칙이 항상 동일합니다.
- **아무 카탈로그도 못 찾으면**: `mergeFontCatalogs()`는 예외를 던지고, CLI는 이를
  잡아서 0이 아닌 종료 코드로 끝납니다(다른 명령들과 동일한 에러 처리 방식,
  `main()` 맨 아래의 `.catch()` 참고).

### 주의할 점

- `result/` 안에는 이전 `merge` 결과(`merged-*.json`)도 남아 있을 수 있습니다.
  `merged-*.json`도 `schemaId`가 `hwpkit.font-catalog/v1`이므로, 인자 없이 다시
  `merge`를 돌리면 이전 merge 결과까지 함께 스캔됩니다. `profileId` 기준 중복
  제거 덕분에 결과 자체는 틀어지지 않지만(같은 폰트가 두 번 들어가지 않음),
  꼭 "이번에 새로 만든 것만" 합치고 싶다면 `merge` 대상 파일을 직접 나열하세요.
- `compare` 결과는 애초에 합칠 수 있는 대상이 아닙니다(폰트 목록이 아니라 순위
  결과이기 때문). `merge`에 섞여 있어도 에러 없이 건너뛸 뿐입니다.

### 새로운 하위 명령을 이런 식으로 하나 더 추가하고 싶다면

`merge`는 "CLI 옵션 파싱 함수(`parseMerge`) + 순수 로직 함수(`mergeFontCatalogs`) +
파일 I/O를 담당하는 실행 함수(`runMerge`)"로 나뉘어 있습니다. 이 세 조각 분리 패턴을
그대로 따라 하면 새 명령을 추가하기 쉽고, 순수 로직 함수는 파일을 안 만들고도
`test/cli.test.mjs`에서 바로 테스트할 수 있습니다. `main()`(642번째 줄)의
`if (command === "merge") ...` 옆에 분기를 하나 추가하고 `HELP` 문자열도 같이
업데이트하는 걸 잊지 마세요.
