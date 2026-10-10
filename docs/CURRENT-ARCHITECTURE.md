# 원래 PC 구조 분석 — 2026-10-10

분석 당시 `clauth 0.14.0`과 프로필 8개를 사용했습니다. 원본 프로그램·계정 파일·예약 작업은 변경하지 않았습니다.

| 구성 | 역할 | 위치 |
|---|---|---|
| clauth 데몬 | 사용량 조회, 프로필 전환, 상태 피드 | `~/.local/bin/clauth.exe` |
| 설정 | 계정 목록, 체인, 90초 조회 | `~/.clauth/profiles.toml` |
| 계정 데이터 | OAuth 토큰, 사용량 캐시·이력 | `~/.clauth/profiles/<name>/` |
| 라이브 동기화 | 검증된 이전 토큰만 새 스냅샷으로 동기화 | `sync-live.ps1`, 2분 |
| 체인 정렬 | 주간 리셋 임박순·사용량·안정 정렬 | `reorder-chain.ps1`, 10분 |
| 계정 불일치 복구 | 신원이 확인된 다른 계정만 복구 | `desync-heal.ps1`, 2분 |
| watchdog | 꺼진 데몬 재시작 | `daemon-watchdog.ps1`, 3분 |
| 숨김 실행 | 터미널 깜빡임 방지 | `run-hidden.vbs` |
| 모니터 | Node HTTP + HTML, 포트 47821 | `~/.clauth/monitor/` |
| 외부 도우미 | 계정 확인·수동 전환 | `~/.claude/skills/clauth-check/scripts/whois.ps1` |

`clauth-aside-sync` 작업은 비활성 상태입니다. 나머지 네 작업은 활성이고 최근 종료 코드는 0이었습니다. 모니터의 건강 표시와 작업 종료 코드만으로 실제 세션 전환 성공을 판정하면 안 됩니다. 분석 시 라이브 자격증명은 일반 파일이었으며, 실행 중인 Claude 프로세스 5개는 VS Code 확장 소속이었습니다.

## 이식 전에 해결해야 했던 문제

1. VBS, WMI, PowerShell, Task Scheduler, 사용자 절대 경로가 Windows에 종속됩니다.
2. 모니터의 전환 함수는 `whois.ps1`을 요구하므로 `.clauth`만 복사해서는 작동하지 않습니다.
3. `whois.ps1`은 전환 명령의 실패 종료 코드를 보존하지 않았고, 화면도 응답 본문의 실패를 표시하지 않았습니다.
4. 수동 로그인 직후 새 refresh token을 오래된 스냅샷으로 덮어쓰면 인증이 깨진 사고 기록이 있습니다.
5. 구형 `.state.json`에도 실제 refresh token이 들어 있습니다. 상태 파일 역시 공유하면 안 됩니다.
6. `clauth 0.14.0`의 macOS 세션 fallback은 코드로 제한돼 있습니다. 0.17.0에는 실제 Keychain 세션 처리 코드가 추가됐습니다.
7. 디스크의 활성 계정과 VS Code의 실행 중인 대화 계정은 동일한 개념이 아닙니다.

새 패키지는 동일한 85%/98% 정책과 화면을 유지하면서 토큰 갱신·채택은 0.17 엔진에 맡깁니다. 예전 live-sync/desync-heal 파일 복사를 다시 얹지 않습니다. 수동 전환은 모호한 상태에서 거부하며, 로그인 복구를 강제로 성공 처리하지 않습니다.

## 컴퓨터 간 공유 범위

GitHub에 저장할 것: 코드, 계정의 로컬 별칭, 전환 임계치, 순서 정책, 설치·검사 방법.

로컬에 남길 것: 인증 정보, Keychain, 이메일 캐시, 사용량, 로그, 백업, runtime, baseline 상태. 같은 계정은 각 컴퓨터에서 각각 인증해야 독립적인 갱신 토큰 흐름을 유지할 수 있습니다. 사용량 한도는 계정 단위이므로 컴퓨터 사이에서도 공유됩니다.

공식 코드 근거: [v0.14 CLI](https://github.com/uwuclxdy/clauth/blob/v0.14.0/src/cli.rs), [v0.17 runtime](https://github.com/uwuclxdy/clauth/blob/v0.17.0/src/runtime.rs), [v0.17 status](https://github.com/uwuclxdy/clauth/blob/v0.17.0/src/daemon/status_json.rs).
