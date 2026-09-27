<!--
Imported verbatim from the owner's research notes on 2026-08-03. Everything below the rule is
unchanged, including the model names and the star ratings.

Read it as an INPUT, not as a decision. Nothing here has been measured against this repo, and
HANDOFF-APP.md section 4 lists the places where its premises and this codebase disagree (the
model id is the first one). No provider named below has been benchmarked, and doing so spends
money, so it goes through the ledger and through an owner armed step like any other spend.
-->

# Real-Time Translation Architecture Research

## 1. Project Context

### Goal

Build a **real-time multilingual video chat application** that translates spoken conversations with the lowest possible latency while maintaining excellent translation quality and minimizing operating cost.

### Primary Objectives

1. Lowest possible latency
2. High translation accuracy
3. Low API cost
4. Simple, maintainable architecture
5. Ability to swap providers as better models become available

### Current Implementation

```text
Speaker
    │
    ▼
Google / Chrome Streaming Speech-to-Text
    │
    ▼
Claude 4 Haiku
    │
    ▼
Translated Text
```

This architecture is modular and already functional.

---

## 2. Current Pipeline Analysis

### Advantages

- Components are loosely coupled.
- Easy to replace either STT or translation independently.
- Claude Haiku is inexpensive.
- Easy to debug because each stage is isolated.

### Disadvantages

- Multiple API calls.
- Additional network latency.
- More orchestration and retry logic.
- More infrastructure to maintain.

---

## 3. Biggest Insight

Replacing Claude Haiku alone probably **will not** dramatically reduce latency.

The largest contributor is often:

1. Speech recognition delay
2. Network round trips
3. Translation
4. Rendering/UI updates

This means benchmarking the entire pipeline is more valuable than benchmarking translation models in isolation.

---

## 4. Translation Model Comparison

| Model | Speed | Cost | Translation Quality | Notes |
|-------|:--:|:--:|:--:|------|
| Claude 4 Haiku | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | Cheap, natural output |
| GPT-5 nano | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐½ | Excellent balance of speed, cost, and quality |
| Gemini 2.5 Flash | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐½ | Very fast and multilingual |
| DeepL API | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Best dedicated translator |

### Claude 4 Haiku

Pros

- Very inexpensive
- Good conversational translations
- Natural phrasing

Cons

- Separate API call
- Doesn't solve overall latency by itself

### GPT-5 nano

Pros

- Extremely fast
- Excellent multilingual capabilities
- Strong value per token

Cons

- Requires benchmarking against Haiku

### Gemini 2.5 Flash

Pros

- Excellent latency
- Strong multilingual support
- Attractive pricing

Cons

- Best fit if already invested in Google

### DeepL

Pros

- Highest translation quality

Cons

- Specialized translator rather than a general LLM.

---

## 5. Streaming Speech Recognition

| Service | Strengths | Weaknesses |
|---|---|---|
| Google STT | Mature, accurate, excellent streaming | Cost at scale |
| OpenAI STT | Great OpenAI ecosystem | Newer |
| Deepgram | Extremely low latency and competitive pricing | Smaller ecosystem |
| AssemblyAI | Excellent transcription features | Less focused on live translation |

---

## 6. Integrated Streaming Speech Models

Traditional pipeline

```text
Speech
   ↓
Speech-to-Text
   ↓
Translation Model
   ↓
Translation
```

Integrated pipeline

```text
Speech
   ↓
Realtime Speech Model
   ↓
Translated Text
(and optionally translated audio)
```

### Benefits

- Fewer API calls
- Fewer network hops
- Lower latency
- Better conversational context
- Less orchestration code

### Trade-offs

- Less modular
- Provider lock-in may increase
- Pricing varies

### Comparison

| Integrated Model | Latency | Cost | Translation Quality | Developer Experience | Notes |
|------------------|:------:|:----:|:-------------------:|:--------------------:|------|
| OpenAI Realtime API | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Best conversational context |
| Google Gemini Live API | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐½ | ⭐⭐⭐⭐ | Great for Google Cloud users |
| Azure AI Speech Translation | ⭐⭐⭐⭐½ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐½ | ⭐⭐⭐ | Enterprise-grade |
| Speechmatics Flow | ⭐⭐⭐⭐½ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | Built for multilingual conversations |

---

## 7. Architecture Options

### Current

```text
Google STT
      ↓
Claude Haiku
```

### Option 2

```text
Google STT
      ↓
GPT-5 nano
```

### Option 3

```text
Deepgram
      ↓
GPT-5 nano
```

### Option 4

```text
Google STT
      ↓
Gemini Flash
```

### Option 5

```text
OpenAI Realtime API
```

---

## 8. Benchmark Plan

Measure:

- Time to first translated token
- End-to-end latency
- Translation quality
- Word Error Rate (WER)
- Cost per hour
- Cost per user
- Bandwidth
- CPU utilization
- User perceived responsiveness

---

## 9. Recommendation

### Short-term

Benchmark:

1. Claude Haiku
2. GPT-5 nano
3. Gemini 2.5 Flash

### Medium-term

Benchmark Google STT against Deepgram.

### Long-term

Prototype:

- OpenAI Realtime API
- Google Gemini Live API

---

## 10. Future Research

- Streaming partial translations
- Speculative translation
- Translation memory
- Glossaries
- Speaker identification
- Automatic language detection
- Audio-to-audio translation
- Conversation context retention

