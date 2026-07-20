# My Desktop Calendar — Windows Native (WPF)

이 폴더는 **단일 HWND** Windows 전용 셸입니다. (앱 버전: v1.1.8)

## 모드 전환: 잠금 vs 창

| 모드 | 동작 |
|------|------|
| **바탕화면** | 같은 `MainWindow`를 **잠금** — 이동·크기조절·최소화·최대화·닫기 불가(타이틀 버튼 숨김), **항상 다른 창 아래**(`HWND_BOTTOM`), Win+D에도 유지. 퀵편집·날짜 더블클릭 시 일시적으로 맨 앞 |
| **창 모드** | 같은 HWND를 **잠금 해제** — 이동·리사이즈·타이틀바 컨트롤 사용, 일반 z-order |
| **UI 오버레이** | 모드 유지한 채 React 오버레이만 (제자리) |

바탕화면에 `SetParent` / Progman / WorkerW 로 임베드하지 않습니다.

## 구조

```
MainWindow (WPF + WebView2 하나)
  ├─ desktop: window lock + HWND_BOTTOM (+ Win+D 유지)
  └─ window:  movable / resizable borderless
```

## 빌드·실행

프로젝트 루트:

```bash
npm run win:run
```

또는 `My Desktop Calendar (Native).bat`
