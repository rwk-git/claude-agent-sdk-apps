# Storage research: advances, insights and opportunities

## Who this is for

A team of storage researchers. Their work covers the whole storage stack: devices and their interfaces, storage servers and fabrics, file systems, and the compute that can run in or near storage. File systems are a major focus.

They want to find papers that relate to storage in any of three ways:

1. **Advances in storage**: the paper improves or proposes something in the storage stack itself (a device interface, an FTL, a file system, a storage server design, a caching or placement policy, in-storage processing, ...).
2. **Insights for storage**: the paper isn't a storage paper, but it reveals something storage designers should know: how a workload reads, writes and keeps data (AI training and inference, agents, analytics), data growth, access patterns, or durability and consistency needs.
3. **Opportunities for storage**: the system in the paper could become faster, cheaper, larger or simpler with better storage, a new file-system abstraction, or compute moved into or near storage. The typical example is LLM inference, where the KV cache outgrows GPU memory and has to move between HBM, DRAM, CXL memory, SSDs and other servers.

## Topics

### Storage devices, interfaces and servers
- SSD internals: FTL, garbage collection, wear and write amplification, over-provisioning, data placement.
- NVMe and its extensions: ZNS (zoned namespaces), FDP (flexible data placement), the NVMe key-value command set, computational storage commands, NVMe-oF.
- Other media and tiers: HDDs (including SMR), tape and archival storage, persistent memory, CXL-attached memory and storage, storage tiering.
- Storage servers and fabrics: JBOF and EBOF enclosures, disaggregated storage, storage networking, storage-server design and efficiency.
- Reliability and efficiency: erasure coding, replication, failure analysis, energy use, cost per TB.

### File systems (major focus)
- New file-system designs and the state of the art: local, distributed and parallel file systems, metadata scaling, crash consistency, caching, file systems for new hardware (ZNS, CXL, persistent memory), user-space and FUSE file systems.
- File systems for new workloads: AI training data and checkpoints, model weights, KV cache, agent workspaces.
- Opportunities for new file systems: papers whose problem a new file-system abstraction or interface could solve better than today's (versioning, snapshots, semantic or content-addressed access, transactional updates, namespaces for agents).

### Storage systems and data management
- Object stores, key-value stores, storage engines (LSM trees, B-trees), and databases whose design is driven by storage.
- I/O stacks: io_uring, SPDK, kernel bypass, block layer and page cache.
- Caching, deduplication, compression and data formats that change the cost of storing or moving data.

### In-storage and near-data computing
- Computational storage and in-storage processing: offloading filters, scans, compression, encryption, search or ML inference to the drive.
- Near-data and in-line processing: processing-in-memory, near-memory compute, operator pushdown, in-network computing.
- DPUs, SmartNICs and IPUs on the storage or network data path, including DPUs in front of storage or inference servers.

### Storage for AI
- KV cache management for LLM inference: offloading and tiering (HBM / DRAM / CXL / SSD / remote), compression and quantization, eviction, prefix caching and reuse, transfer in disaggregated prefill/decode, sharing across nodes.
- Model weights and data movement: weight streaming and offloading (including MoE experts), checkpointing, training data loading and preprocessing.
- Retrieval: vector search and RAG indexes on SSDs, embedding tables, large-scale document stores.
- Quantization, sparsity and compression *when they reduce footprint or bandwidth*.

### Agentic AI and storage
- **Agent memory**: how agents keep, organize, retrieve and forget memory, and what that means for the storage layer underneath (persistence, indexing, versioning, scale, latency).
- **Agents and file systems**: agents that work with files, shells and workspaces; file systems as an agent tool or memory; sandboxing, snapshots and rollback of agent actions; context stored as files.
- **Tools and data access**: tool-calling and retrieval patterns that create new I/O workloads.
- Where in-storage or near-data compute could serve agents (search, filtering or summarization done next to the data).
- AI and agents applied to storage itself: tuning, managing or designing storage systems and file systems.

## Out of scope (low scores)

- ML algorithms, training recipes, prompting, reasoning, alignment and benchmarks with no implications for how data is stored, moved or accessed.
- Agent papers about planning, reasoning or multi-agent coordination where memory and tools play no part. (Agent memory designs that only change what goes into the prompt are weak fits: score them 3-4, or higher if they make concrete demands on a storage layer.)
- Quantization or compression evaluated only for accuracy, with no footprint, bandwidth or latency angle.
- Applications of AI to unrelated domains (medicine, law, education, ...).
- "Memory" or "storage" used only as a metaphor.

## Scoring guide

- **9-10 (excellent)**: a direct advance in storage, file systems or in-/near-storage computing, or a systems paper where the storage or memory tier is the core of the contribution (e.g. KV cache tiering to SSDs, a file system for agents).
- **7-8 (strong)**: systems work in which storage, file systems or the memory hierarchy are a central part, or a paper with strong, concrete insights for storage (e.g. an I/O characterization of AI or agent workloads).
- **5-6 (moderate)**: the contribution is elsewhere, but there is a clear and specific insight for storage or opportunity for it (e.g. an agent memory design that implies concrete persistence or retrieval requirements, or a data-movement-bound system).
- **3-4 (weak)**: the link to storage is generic ("this needs a lot of data").
- **0-2 (none)**: unrelated.
