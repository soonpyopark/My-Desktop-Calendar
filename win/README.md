# My Desktop Calendar — Windows Native (WPF)

이 폴더는 **단일 HWND 바탕화면 임베드**용 Windows 전용 셸입니다.

## 모드 전환: MainWindow 하나 + SetParent 왕복

| 모드 | HWND 상태 |
|------|-----------|
| **바탕화면** | `MainWindow` → `SetParent(SysListView32)` |
| **창 모드** | `SetParent(null)` + top-level borderless / resize |
| **UI 오버레이** | 임베드 유지한 채 React 오버레이만 (제자리) |

전환 시 깜빡임은 `DesktopTransitionCover`(프레임 캡처)로 가립니다.

## 구조

```
MainWindow (WPF + WebView2 하나)
  ├─ desktop: SetParent → SysListView32
  └─ window:  top-level Show
```

## 빌드·실행

프로젝트 루트:

```bash
npm run win:run
```

또는 `My Desktop Calendar (Native).bat`
