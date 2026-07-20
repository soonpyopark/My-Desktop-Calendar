# My Desktop Calendar v1.1.7

Windows 전용 데스크톱 캘린더입니다. **WPF (.NET 8) 네이티브 셸** + **React UI**(WebView2)로 동작합니다.

월·주·연 보기, 음력·음력 반복 일정, 대한민국 공휴일, JSON/ICS/CSV 가져오기·내보내기, **바탕화면 위젯(단일 HWND + SetParent)**, **시스템 트레이**, **MSI 설치판**, **로컬 HTTP 웹 동기화**를 지원합니다.

홈페이지: [https://note4all.tistory.com](https://note4all.tistory.com)

## 기술 구성

| 구성 | 설명 |
|------|------|
| **셸** | **WPF (.NET 8) 단일 HWND** — MainWindow + WebView2 하나; 바탕화면↔창은 `SetParent` 왕복 (전환 커버로 깜빡임 완화) |
| **UI** | React 18 + Vite + Tailwind (WebView2 로컬 가상 호스트) |
| **저장소** | exe 옆 `data/` JSON — WebView2 `postMessage` 브리지 |
| **웹 접속** | `.env`의 `PORT`/`HOSTNAME` — 앱 실행 중 브라우저 접속 (예: `http://127.0.0.1:3010/`) |
| **실시간 동기화** | 로컬 앱 ↔ 브라우저 `/ws` WebSocket (`store-changed`) |
| **임베드** | `syslistview32`(네이티브 클릭 패스스루) → `auto` → raised / workerw / progman / zorder (Win10·Win11 셸 폴백) |
| **설치** | 포터블 (`win:publish`) 또는 WiX MSI (`build:dist:msi`, 현재 사용자) |

자세한 셸 설명: [`win/README.md`](win/README.md)

**지원 OS:** Windows 10 / 11 + [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) (사실상 Win10+; Win7/8은 대상 아님).

### v1.1.6의 임베드 개선점

v1.1.5는 바탕화면 임베드 시 `Progman`/`WorkerW`의 형제(sibling)로 붙기 때문에, `SHELLDLL_DefView`가 실제 마우스 클릭을 가로채 네이티브 입력이 WebView2까지 도달하지 못합니다. 이를 보완하기 위해 `UndockZoneMonitor`가 전역 마우스 폴링으로 클릭 영역을 흉내 냅니다.

v1.1.6은 임베드 시 **`SysListView32`(바탕화면 아이콘 리스트뷰) 안쪽**에 `WS_POPUP` 스타일로 `SetParent`하는 전략을 새로운 1순위 시도로 추가했습니다. 이 경로가 성공하면 실제 마우스 클릭이 별도 폴링 없이 WebView2로 네이티브 전달됩니다. 이 전략이 실패하거나 검증되지 않으면 자동으로 기존 v1.1.5의 `auto → raised → workerw → progman` 체인으로 폴백하며, `UndockZoneMonitor`는 안전망으로 계속 동작합니다.

## 시작하기

```bash
npm install
npm run win:run
```

또는 **`My Desktop Calendar (Native).bat`**

종료:

```bash
npm run win:stop
```

### 포터블 배포

```bash
npm run win:publish
```

→ `dist-win/MyDesktopCalendar.exe` (self-contained)  
대상 PC에 WebView2 Runtime이 필요합니다.  
없으면 앱이 **온라인**이면 Bootstrapper를 받아 설치를 제안하고, **오프라인**이면 별도 `program/` 패키지 설치가 필요하다는 안내만 표시합니다.  
오프라인용 사전 설치 파일은 `npm run webview2:fetch-installer`로 `program/`에 받아 **MSI와 따로** 배포하세요(`program/`는 gitignore, MSI에 포함되지 않음).

### MSI 설치판

```bash
npm run build:dist:msi
```

사전 요구: [WiX CLI 7+](https://wixtoolset.org/) (`winget install WiXToolset.WiXCLI`) 후 `wix eula accept wix7`  
→ `msi/My Desktop Calendar v{버전}_YYMMDD_HHMMSS.msi`  
현재 사용자(`%LocalAppData%\My Desktop Calendar`)에 설치되며, 관리자 권한이 필요 없습니다. 시작 메뉴·바탕화면 바로가기가 등록됩니다.  
WebView2 Runtime은 MSI에 포함되지 않습니다(시스템 Evergreen).  
오프라인 PC용 설치 파일은 `npm run webview2:fetch-installer`로 `program/`에 받은 뒤, MSI와 **별도 패키지**로 제공하세요.

공휴일 API 키: 빌드 PC의 `.env`(`DATA_GO_KR_SERVICE_KEY`) 또는 로컬 `data/settings.json`(저장 체크됨)에서 읽어, 설치본에 **키가 채워지고 「저장」이 체크된 상태**로 포함합니다.

## 주요 기능

- **창 모드 / 바탕화면 모드** — 헤더·트레이에서 전환 (크기·위치 유지); 설정/검색/편집은 제자리 오버레이
- **프레임리스 창** — 커스텀 타이틀바 + 가장자리 리사이즈; 리사이즈 중에는 고스트로 콘텐츠 재배치를 줄임
- **날짜 칸 더블클릭** — 퀵 편집(제목 `7. 9.(목) (음 5. 25.)`, 종일 추가, 완료 체크, 날짜색·연필→전체 편집기)
- **일정 바** — 좌클릭 퀵 편집; 바탕화면에서 **우클릭 → 상세**; 완료 시 취소선(배경색 없음)
- **날짜 배경색** — 3×5 팔레트(무색·프리셋·기타 색상)
- **헤더 바로가기** — 오늘, 창/바탕화면, **브라우저에서 편집**(`http://localhost:{PORT}/`, 네이티브만), 일정 숨기기(눈 아이콘)
- **주 번호** — 날짜 호버·선택 시 같은 주 칸에 강조
- **대한민국의 휴일** — 동기화(또는 최초 시드)로만 갱신; 가져오기/일반 편집으로는 덮어쓰지 않음
- **가져오기 / 내보내기** — JSON, ICS, CSV (개별·전체)
- **시스템 트레이** — 닫기 시 트레이; 창 모드 / 바탕화면 / 종료
- **로그인 유지** — `data/admin-sessions.json`
- **음력 반복** — 음력 매년·매월
- **테마** — 라이트 / 다크 / 시스템
- **HTTP 웹** — `.env`에 `PORT`가 있으면 시작 시 로컬 서버 기동; 브라우저 UI에서는 창/바탕화면/웹 아이콘 숨김
- **바탕화면 네이티브 클릭 패스스루** — `SysListView32` 임베드 성공 시 클릭-영역 폴링 없이 실제 마우스 입력이 그대로 전달 (실패 시 기존 폴백 체인 + `UndockZoneMonitor` 안전망)

## 명령

| 명령 | 설명 |
|------|------|
| `npm run win:run` | UI 빌드 + WPF 네이티브 실행 |
| `npm run win:stop` | 실행 중인 네이티브 앱 종료 |
| `npm run win:publish` | self-contained 포터블 출력 (`dist-win/`) |
| `npm run build:dist:msi` | WiX MSI 설치판 (`msi/*.msi`) |
| `npm run update:all` | git pull + npm 의존성 + `dotnet restore` (+ `sync-version`) |
| `npm run build:update_all` | `update:all` 후 MSI 빌드 (`update_all.bat _inner build`) |
| `npm run win:sync-ui` | `dist/` → `win/.../wwwroot` 동기화 |
| `npm run build` | 프론트엔드 프로덕션 빌드 |
| `npm run sync-version` | `APP_VERSION` → package.json / LICENSE / README / MSI License.rtf 등 |

의존성 일괄 갱신(Windows):

```bat
update_all.bat
```

갱신 후 MSI까지 빌드:

```bat
npm run build:update_all
```

옵션: `build` `force` `skip-git` `skip-npm` `skip-dotnet`  
로그: `.cache/logs/update-all.log`

## 환경 설정

`.env.example`을 참고해 `.env`를 만듭니다. 네이티브 셸은 `MYCALENDAR_ADMIN_ID` / `MYCALENDAR_ADMIN_PW`(또는 `ADMIN_ID` / `ADMIN_PW`)를 exe 옆·프로젝트 루트 `.env`에서 읽습니다.

| 키 | 설명 |
|----|------|
| `MYCALENDAR_ADMIN_ID` / `MYCALENDAR_ADMIN_PW` | 관리자 로그인 |
| `PORT` / `HOSTNAME` / `ALLOWED_HOSTS` | 선택적 HTTP 웹 서버 (+ `/ws`); 권장 예: `PORT=3010`, `HOSTNAME=127.0.0.1` |
| `DATA_GO_KR_SERVICE_KEY` | 공휴일 API (선택) |
| `DATA_ROOT` | 데이터 폴더 경로 (기본: exe 옆 `data/`) |

## 라이선스

MIT — 자세한 내용은 [LICENSE](LICENSE)를 참고하세요.
