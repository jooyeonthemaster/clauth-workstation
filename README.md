# Clauth Workstation

내 여러 Windows·macOS 컴퓨터에서 같은 Claude 계정 운영 정책과 모니터를 사용하는 개인용 패키지입니다. **기존 PC를 자동으로 덮어쓰지 않습니다.** 새 컴퓨터에 설치하고 각 계정을 직접 로그인하세요.

현재 단계는 **검증 중인 이식판**입니다. 테스트 통과는 가상 계정·HTTP·프로세스 제어 로직의 검증이며, 실제 구독 계정과 VS Code 확장의 무중단 전환 보장은 아닙니다. 실제 컴퓨터 확인 항목은 [ACCEPTANCE.md](docs/ACCEPTANCE.md)에 있습니다.

## 포함된 것

- 기존 한국어 모니터: 계정별 5시간·주간·모델별 사용량, 리셋 시각, 추세, 활성 계정, 전환 결과.
- Windows x64, macOS Apple Silicon/Intel용 `clauth 0.17.0` 다운로드 및 고정 SHA-256 검증.
- 5시간 85%, 주간·모델별 98%, 90초 조회, 주간 리셋 임박순 체인 정렬.
- Windows 예약 작업과 숨김 실행 바로가기, macOS LaunchAgent와 로컬 `.app` 실행기.
- 사용 중인 데몬과 중복·충돌하는 구동을 거부하는 감독 기능.
- localhost에만 열리는 모니터. 제어 요청에는 Origin·Host·CSRF 검증, 용량 제한, 순차 처리가 적용됩니다.

계정명 `main`, `acc2`~`acc8`과 기존 정책은 [config/workstation.json](config/workstation.json)에 있습니다. 이메일·계정 토큰·사용량·이력은 저장소에 없습니다. 설치한 컴퓨터의 로컬 상태만 모니터링합니다. 여러 컴퓨터를 하나의 화면에서 원격 제어하는 서버는 포함하지 않습니다.

## 새 컴퓨터 설치

필요한 것: **Node.js 22 이상**, Git, 정상 실행되는 Claude Code CLI. Windows에서는 Git for Windows와 Developer Mode의 심볼릭 링크 권한도 필요합니다. CLI에서 `claude --version`이 먼저 동작해야 합니다.

```sh
git clone https://github.com/jooyeonthemaster/clauth-workstation.git
cd clauth-workstation
npm run setup
```

추가 npm 패키지 설치는 없습니다. `setup`은 고정 엔진을 `~/.clauth-workstation/bin/`에 내려받고 새 clauth 설정과 모니터 실행기를 만듭니다. 기존 `~/.local/bin/clauth`는 교체하지 않습니다. 이미 clauth 설정이나 예전 예약 작업이 있으면 중단합니다.

각 컴퓨터에서 계정을 각각 로그인합니다. **같은 계정이어도 다른 컴퓨터의 토큰 파일을 복사하지 마세요.** 자동으로 열린 브라우저의 로그인 계정이 의도한 계정인지 승인 화면에서 확인합니다. 필요하면 출력된 URL을 시크릿 창에서 여세요.

```sh
node src/cli.mjs login main
node src/cli.mjs login acc2
node src/cli.mjs login acc3
node src/cli.mjs login acc4
node src/cli.mjs login acc5
node src/cli.mjs login acc6
node src/cli.mjs login acc7
node src/cli.mjs login acc8
npm run doctor
node src/cli.mjs service install
node src/cli.mjs open
```

보유한 계정만 등록하면 됩니다. 실제 로그인된 계정만 체인에 포함합니다. 세션 자동 전환에는 최소 2개가 필요합니다. `acc3`을 등록한 경우 기존 정책대로 마지막 대기 계정으로 설정합니다. 최초 계정 등록/정책 설정은 서비스 가동 전에 완료하세요.

Windows에서는 바탕화면 `Clauth Workstation` 바로가기, macOS에서는 `~/.clauth-workstation/Clauth Monitor.app`으로 화면을 엽니다. 브라우저 주소는 `http://127.0.0.1:47821/`입니다. 런처는 별도의 Electron 앱이 아닌 로컬 웹 앱입니다. 컴퓨터를 다시 로그인하면 서비스가 자동 시작됩니다.

## Claude 실행

터미널 세션이 계정 전환을 따라가게 하려면 저장소에서 다음과 같이 실행합니다.

```sh
node src/cli.mjs start main
node src/cli.mjs start main -- --model sonnet
```

내부적으로 **`clauth start --with-fallback main`**을 실행합니다. 옵션 순서가 중요합니다. 계정은 OAuth 계정이어야 하며, 체인에 등록돼 있고 데몬이 실행 중이어야 합니다. 기존에 열려 있던 일반 `claude` 프로세스나 VS Code 확장 대화까지 자동으로 이 방식으로 바뀌지는 않습니다.

모니터의 수동 전환은 **기본 전역 계정**을 바꿉니다. 이미 실행 중인 `clauth start` 관리 세션은 자체 runtime과 fallback을 사용하므로 기본 계정 버튼으로 즉시 이동하지 않습니다. 여러 컴퓨터의 현재 활성 계정도 각각 독립적입니다.

**VS Code:** 확장의 로그인 계정 변경과 실행 중인 대화의 과금 계정 변경은 다릅니다. 이 패키지는 VS Code 사용자 설정을 자동 수정하거나 열린 대화를 재시작하지 않습니다. 현재 지원 기준은 VS Code 안의 터미널에서도 위 명령을 사용하는 것입니다. 확장 패널의 무중단 전환은 별도 실제 검증이 남아 있습니다.

## 현재 PC에서 살펴보기

기존 자동화를 유지한 채 읽기 전용 모니터만 다른 포트에 열 수 있습니다.

```sh
npm run monitor -- --port 47822
```

현재 PC를 새 엔진으로 이전하는 절차는 [MIGRATION.md](docs/MIGRATION.md), 기존 구조 분석은 [CURRENT-ARCHITECTURE.md](docs/CURRENT-ARCHITECTURE.md)를 참고하세요. 구형 복구 스크립트와 새 엔진을 동시에 실행하지 않습니다.

## 검사·제거

```sh
npm run check
npm test
node src/cli.mjs service uninstall
```

제거 명령은 이 패키지의 자동 시작 등록만 제거합니다. 계정·토큰·기존 엔진은 삭제하지 않으며 이미 실행 중인 native clauth 데몬이 남을 수 있습니다. 저장소 경로나 Node 실행 파일 위치를 옮기면 자동 시작을 다시 설치해야 합니다.

## 엔진과 검증 범위

전환 엔진은 외부 프로젝트 [uwuclxdy/clauth](https://github.com/uwuclxdy/clauth)입니다. 이 저장소는 엔진을 재작성하지 않고 개인용 설치·정책·모니터를 제공합니다. [v0.17.0](https://github.com/uwuclxdy/clauth/releases/tag/v0.17.0)은 macOS Keychain 세션 전환을 지원하지만 실제 계정 흐름은 각 컴퓨터에서 확인해야 합니다. 엔진의 자동 업데이트는 끄고 검증된 버전을 고정합니다.

CI는 Windows x64·macOS Intel·macOS ARM에서 가상 데이터 테스트와 고정 엔진 다운로드/실행을 검사합니다. 실제 로그인, Keychain 승인, VS Code 세션, 재부팅 후 실행까지 검증했다는 의미는 아닙니다.
