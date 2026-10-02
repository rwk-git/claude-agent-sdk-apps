# Computational storage, and where it could help

## Who this is for

A researcher in computational storage who wants two kinds of papers:

1. Papers **in the field**: computational storage, DPUs, in-/near-storage and near-data processing, and the memory/storage hierarchy around them.
2. Papers **from other fields** (especially AI/ML systems) whose bottleneck is memory capacity, memory or I/O bandwidth, or data movement, so that a smarter storage layer or moving compute closer to the data could change their results. The typical example is LLM inference, where the KV cache grows larger than GPU memory and gets moved between HBM, DRAM, CXL, SSDs and other servers over the network.

## Core topics (high scores)

- **Computational storage and in-storage computing**: computational SSDs, NVMe computational storage, offloading scans, filters, compression, encryption, deduplication, search or ML inference to the drive or its controller.
- **Near-data and in-line processing**: processing-in-memory (PIM), near-memory compute, active storage, in-network computing, query/operator pushdown, CXL devices with compute, processing data as it flows through the I/O path.
- **DPUs, SmartNICs and IPUs**: offloading the storage or network data path, NVMe-oF, disaggregated storage and memory, storage services on DPUs, DPUs in front of inference servers.
- **KV cache management for LLM inference**: offloading and tiering (HBM / DRAM / CXL / SSD / remote), compression and quantization of the KV cache, eviction, prefix caching and reuse across requests, transferring the KV cache in disaggregated prefill/decode, sharing it across nodes.
- **Storage and data movement for AI**: weight streaming and offloading (including MoE experts) from host memory or SSD, checkpointing, training data loading, vector search and RAG retrieval on SSDs, embedding tables, long-context memory pressure.
- **Data reduction**: compression (classical, learned, or LLM-based), quantization *when it reduces footprint or bandwidth*, deduplication, sparsity and encodings that cut data movement.
- **Memory/storage hierarchy and I/O stacks**: CXL memory, tiered and disaggregated memory, persistent memory, SSD internals (FTL, ZNS, FDP), io_uring/SPDK, file systems, object stores and databases designed for these devices or for AI workloads.

## Opportunity topics (medium-to-high scores when the storage angle is real)

Papers whose main contribution is elsewhere but whose performance or cost is dominated by memory footprint, bandwidth or data movement: long-context and agentic inference at scale, retrieval-heavy pipelines, large-scale data processing and analytics, graph processing, scientific or genomics data pipelines. Test: *would moving compute closer to the data, or a smarter storage layer, materially change this paper's results?* If yes, say how.

## Out of scope (low scores)

- ML algorithms, training recipes, prompting, reasoning, alignment, benchmarks and agent designs with no systems or data-movement implications.
- "Memory" in the cognitive or agent sense (conversation memory, episodic memory, memory-augmented agents) unless the paper is about how that memory is stored, indexed, retrieved or moved efficiently at scale.
- Quantization or compression evaluated only for accuracy, with no footprint, bandwidth or latency angle.
- Applications of AI to unrelated domains (medicine, law, education, ...).

## Scoring guide

- **9-10 (excellent)**: directly about computational storage, DPUs, in-/near-storage or near-data processing, or KV cache / weight / data movement where the memory or storage tier is central.
- **7-8 (strong)**: systems work on the memory/storage hierarchy, offloading, I/O for AI, or compression/quantization for footprint and bandwidth, with clear relevance to storage.
- **5-6 (moderate)**: the contribution is elsewhere, but there is a clear and specific opportunity for storage or near-data computing.
- **3-4 (weak)**: the link to storage is generic ("this needs a lot of data").
- **0-2 (none)**: unrelated.
