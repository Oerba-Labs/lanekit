---
name: land-ready
description: Land every lane that is ready, in the landing order, reading the order again after each land.
disable-model-invocation: true
allowed-tools: mcp__plugin_lanekit_lanekit__lanes
---

1. **Read the order** with `lanes`. The lanes *ready to land*, in the order it gives, are the plan; a lane that waits
   for another, needs a gate or has uncommitted work is not in it.
2. **Show the person the plan** — which lanes, in which order — and go on only on their yes.
3. **Land the first** with `land`, and say what it reported.
4. **Read the order again** before the next. A land moves `main`: a lane that changed the same files now needs a gate,
   and is no longer ready. Land the next only while `lanes` still says it is *ready to land*.
5. **Stop at the first refusal**, with its words. Never step past one (no forcing, no merging by hand).
6. Report what landed and what is left, and what each left needs. Landing pushes nothing: the push is the person's.
