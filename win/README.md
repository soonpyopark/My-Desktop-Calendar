# My Desktop Calendar — Windows Native (WPF)

이 폴더는 **이중 HWND 바탕화면 임베드**용 Windows 전용 셸입니다.

## 제1규칙: 전환 시 SetParent 금지

| HWND | 역할 | 부모 |
|------|------|------|
| **AppWindow** (`MainWindow`) | 창모드 + 임시 UI | 항상 top-level |
| **DesktopHost** | 바탕화면 위젯 | 최초 1회만 Progman/WorkerW |

창모드 ↔ 바탕화면 · 임시 편집 UI는 **Show / Hide만** 사용합니다. DesktopHost는 숨긴 동안에도 셸 부모를 유지합니다.

## 구조

```
AppWindow (WPF + WebView2)     ← 창모드 / 오버레이
DesktopHost (WPF + WebView2) ← 바탕화면 (SetParent 1회)
        ↕ 동일 store / NativeBridge 이벤트
```

## 빌드·실행

프로젝트 루트:

```bash
npm run win:run
```

또는 `My Desktop Calendar (Native).bat`
