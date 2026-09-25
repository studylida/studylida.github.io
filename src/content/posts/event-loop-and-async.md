---
title: "자바스크립트 이벤트 루프(Event Loop)와 비동기 런타임"
description: "싱글 스레드 자바스크립트가 비동기 작업을 처리하는 원리와 브라우저 렌더링의 상호작용"
pubDate: 2026-09-26
tags: ["JavaScript", "Browser", "Async", "Performance"]
category: "Frontend"
draft: false
---

# 이벤트 루프와 동시성 모델

자바스크립트는 기본적으로 단 하나의 호출 스택(Call Stack)만을 사용하는 **싱글 스레드(Single-threaded)** 언어입니다. 즉, 한 번에 단 하나의 작업만 실행할 수 있습니다. 

그렇다면 네트워크 요청(fetch), 타이머(setTimeout), 사용자 이벤트 같은 수많은 비동기 작업들을 어떻게 멈춤(Block) 없이 부드럽게 처리할 수 있을까요? 그 비밀은 바로 브라우저 런타임 환경의 **이벤트 루프(Event Loop)**에 있습니다.

---

## 1. 런타임 환경의 핵심 구성 요소

이벤트 루프를 이해하기 위해서는 브라우저의 4가지 주요 구성 요소를 파악해야 합니다.

### 콜 스택 (Call Stack)
함수가 실행될 때 생성되는 실행 컨텍스트(Execution Context)가 쌓이는 공간입니다. LIFO(Last In, First Out) 구조로 동작하며, 현재 실행 중인 코드가 스택 최상단에 위치합니다.

### Web APIs
브라우저 환경(V8 외부)에서 제공하는 백그라운드 스레드 기능입니다. DOM 조작, AJAX 네트워크 통신, `setTimeout` 등이 여기서 처리됩니다.

### 태스크 큐 (Task Queue / Macrotask)
Web API에서 비동기 처리가 끝난 콜백 함수들이 대기하는 큐입니다. `setTimeout`, `setInterval`, `setImmediate` 등의 콜백이 여기에 들어옵니다.

### 마이크로태스크 큐 (Microtask Queue)
일반 태스크 큐보다 **더 높은 우선순위**를 갖는 특별한 큐입니다. `Promise.then()`, `queueMicrotask`, `MutationObserver` 콜백이 이곳에 저장됩니다.

---

## 2. 이벤트 루프의 실행 우선순위

이벤트 루프는 끊임없이 콜 스택과 큐를 감시하는 무한 루프입니다:

1. **콜 스택 검사:** 현재 실행 중인 동기 코드가 모두 끝나 콜 스택이 텅 빌 때까지 기다립니다.
2. **마이크로태스크 큐 비우기:** 마이크로태스크 큐에 대기 중인 콜백이 있다면, 큐가 완전히 빌 때까지 모두 꺼내 콜 스택으로 올립니다.
3. **브라우저 렌더링 체크:** 화면을 갱신해야 할 시점(보통 16.6ms 주기, 60fps)이라면 렌더링 파이프라인(Style, Layout, Paint)을 실행합니다.
4. **매크로태스크 큐 1개 실행:** 태스크 큐에서 가장 오래된 콜백 1개를 꺼내 콜 스택으로 올린 뒤 1단계로 돌아갑니다.

---

## 3. 코드 실행 순서로 보는 실전 예제

아래 코드가 콘솔에 어떤 순서로 출력될지 예측해 보세요.

```javascript
console.log('1. 동기 코드 시작');

setTimeout(() => {
  console.log('2. setTimeout 매크로태스크');
}, 0);

Promise.resolve().then(() => {
  console.log('3. Promise 마이크로태스크');
});

console.log('4. 동기 코드 끝');