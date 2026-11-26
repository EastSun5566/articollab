# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [0.10.0-beta.0](https://github.com/EastSun5566/articollab/compare/v0.9.0...v0.10.0-beta.0) (2026-11-26)

### ⚠ BREAKING CHANGES

* **sync:** `SyncHttpError` is now `SyncRequestError`.
* **sync:** Replace `sync.stop()` with `sync.close()` and check for status `"closed"` in place of `"stopped"`.
* **options:** Rename `historyLimit` to `maxHistory` in `createServer()` and `bodyLimit` to `maxBodySize` in `createSyncHandler()`.
* **errors:** Numeric options, indices and counts now throw `TypeError` for non-numbers and `RangeError` for out-of-range or non-integer numbers.
* **wire and checkpoints:** Upgrade all readers before using Counters or Text formatting in a shared document. 0.9 rejects `counter/add`, `counterMap/add`, `counterMap/delete`, `text/mark`, `text/block` and Text snapshots containing `marks` or `blocks`.
* **schema migrations:** Changing a Value to a Counter requires a data migration. Old `value/set` operations can remain in retry records after pending work is confirmed and history is empty. See [Upgrading from 0.9 to 0.10](docs/upgrading.md#upgrading-from-09-to-010).

* **sync:** rename SyncHttpError to SyncRequestError ([b5340fc](https://github.com/EastSun5566/articollab/commit/b5340fcf9c4a8e24e727ca879be809e357fe8da8))

### Features

* add counter and counters collections ([ebbae79](https://github.com/EastSun5566/articollab/commit/ebbae79fd74d20a722b72d3c6fe7be91e1714bbc))
* cap, group and exclude undo steps ([9595976](https://github.com/EastSun5566/articollab/commit/959597654220f5f988e5e62c584d3676a002579f))
* let several tabs open writers from one store key ([512225f](https://github.com/EastSun5566/articollab/commit/512225f277210ccb1fb7f0af6aaf6c79b0821d23))
* share presence over the sync channel ([38fa673](https://github.com/EastSun5566/articollab/commit/38fa673453a4f5205e5f0d9d715d783108d933df))
* **sync:** add a WebSocket transport ([00e4aed](https://github.com/EastSun5566/articollab/commit/00e4aede17842590d741c94a1243d108d773c558))
* **text:** format Text paragraphs with block attributes ([44aebcf](https://github.com/EastSun5566/articollab/commit/44aebcfc03d653080ff69e48c6edf88c45013a0e))
* **text:** format Text with anchored marks ([05f3adc](https://github.com/EastSun5566/articollab/commit/05f3adcdbd71a9e6fe9e75a9f128e17dc3752c26))
* track a batch's outcome with track() and settled() ([f01e3ea](https://github.com/EastSun5566/articollab/commit/f01e3ea1c63139321f849861b6b66fe4978d7fae))
* undo and redo a writer's own changes ([06e390a](https://github.com/EastSun5566/articollab/commit/06e390a2599941af1f8a355da19d2b3aee0f9a37))
* **undo:** undo and redo paragraph attributes ([1c3e194](https://github.com/EastSun5566/articollab/commit/1c3e194eda66075c1a4a54917abd70e7324cfcc0))
* **undo:** undo and redo Text formatting ([13875be](https://github.com/EastSun5566/articollab/commit/13875bee83ca71203a98526d03c2b150f2b673d9))
* validate payloads with Standard Schema ([8dc6569](https://github.com/EastSun5566/articollab/commit/8dc6569fb60a029e598848618467fdd9d23f3cba))

### Bug Fixes

* align the new 0.10 APIs before their first release ([f20a7e7](https://github.com/EastSun5566/articollab/commit/f20a7e7f1a82575d6f71128daa638233531ec96d))
* ignore presence states set after the client stops ([51bf786](https://github.com/EastSun5566/articollab/commit/51bf7869737175e0aec633710d81068a9ebf1c89))
* let startGroup() run after destroy(), as documented ([d647c61](https://github.com/EastSun5566/articollab/commit/d647c6136e8e13955aa48917f02aeffa7cf16320))
* name limits max*, close sync clients and type option errors ([3b08d42](https://github.com/EastSun5566/articollab/commit/3b08d42bf6aa91f7e99a8313d62cb9370746541f))
* refuse an undo manager created inside a transaction ([8ab46ff](https://github.com/EastSun5566/articollab/commit/8ab46ffb71623a83e1de1608d16482633a4819eb))
* **sync:** close two WebSocket races found in review ([c40cf6f](https://github.com/EastSun5566/articollab/commit/c40cf6ff4a21bf36d5779bb9348ab903ef91a38a))
* **sync:** drop presence when its session closes, without scanning sessions ([ddded6e](https://github.com/EastSun5566/articollab/commit/ddded6e82ba8067be906d2382e863a0b0256d0e8))
* **sync:** open a WebSocket subscription as its reply arrives ([4974d44](https://github.com/EastSun5566/articollab/commit/4974d44abc8d705a4252e0426c3ccea3b78a4db0))
* **text:** remember earlier states by identity in a paragraph run ([a90c247](https://github.com/EastSun5566/articollab/commit/a90c2474959ac076e3fa4aa077be6155bf6ddf35))
* throw TypeError for non-number List and Text indices ([67cc855](https://github.com/EastSun5566/articollab/commit/67cc855d864e55f0854f95d889476fe28dac39dc))
* **undo:** revert a Text mark over its own range ([482be8d](https://github.com/EastSun5566/articollab/commit/482be8dca9af957c09d0265fbd85811941e24613))

## [0.9.0](https://github.com/EastSun5566/articollab/compare/v0.8.0...v0.9.0) (2026-11-22)

### Features

* move List elements without changing their identity ([0015b6d](https://github.com/EastSun5566/articollab/commit/0015b6d1e252f155ed95088a8325bf16a1e48d18))
* report when the server transforms or rejects a writer's batch ([c4aedc1](https://github.com/EastSun5566/articollab/commit/c4aedc12a038875999ee0b8d4fe25b3692c13173))

### Bug Fixes

* **examples:** hide the kanban rename form when no card is selected ([8e373b5](https://github.com/EastSun5566/articollab/commit/8e373b542c16799e2ba86e5467eefc798531b7f0))
* reject a moved element's position ID as a List target ([22be679](https://github.com/EastSun5566/articollab/commit/22be679fdd38cbc9f741f1b4bddb72009d790280))

## [0.9.0-beta.0](https://github.com/EastSun5566/articollab/compare/v0.8.0...v0.9.0-beta.0) (2026-11-22)

### Features

* move List elements without changing their identity ([0015b6d](https://github.com/EastSun5566/articollab/commit/0015b6d1e252f155ed95088a8325bf16a1e48d18))
* report when the server transforms or rejects a writer's batch ([c4aedc1](https://github.com/EastSun5566/articollab/commit/c4aedc12a038875999ee0b8d4fe25b3692c13173))

### Bug Fixes

* **examples:** hide the kanban rename form when no card is selected ([8e373b5](https://github.com/EastSun5566/articollab/commit/8e373b542c16799e2ba86e5467eefc798531b7f0))
* reject a moved element's position ID as a List target ([22be679](https://github.com/EastSun5566/articollab/commit/22be679fdd38cbc9f741f1b4bddb72009d790280))

## [0.8.0](https://github.com/EastSun5566/articollab/compare/v0.7.2...v0.8.0) (2026-11-22)

### Features

* add a keyed Map collection ([2e26a3e](https://github.com/EastSun5566/articollab/commit/2e26a3e9eba622a47eccc301f5f5638ceac9c2c2))
* **sync:** persist checkpoints in IndexedDB or a file, saving after every local edit ([8588428](https://github.com/EastSun5566/articollab/commit/8588428a5dc3a751bbde9665cfa4caa59aae9763))

### Bug Fixes

* **sync:** finish a closing store's operations before releasing its lock ([834aa14](https://github.com/EastSun5566/articollab/commit/834aa14a966fffbc45f7b5326b73d9c883bf3827))

### Performance Improvements

* **text:** reuse saved ID ranges when building snapshots ([a010d09](https://github.com/EastSun5566/articollab/commit/a010d09abcc966c2b1854c4b171438cdd1de6e4b))

### Benchmarks

* measure checkpoint save and restore costs for JSON, gzip and Brotli ([9efc26a](https://github.com/EastSun5566/articollab/commit/9efc26aaf837834c67e5675ef11307aff8dd1e2a))

### Upgrade

Existing 0.7.2 checkpoints restore with the same schema, document lineage and writer sessions. Upgrade all readers before enabling Map for a shared document. The Node.js file store uses the default lock manager from Node.js 24.5. See the [upgrade guide](docs/recovery.md#upgrading-from-07-to-08).

## [0.7.2](https://github.com/EastSun5566/articollab/compare/v0.7.1...v0.7.2) (2026-11-22)

### Bug Fixes

* **sync:** bound SSE backpressure for slow readers ([b7a38ff](https://github.com/EastSun5566/articollab/commit/b7a38ff3f00648044a2e8b00bba20880cd056a06))

### Performance Improvements

* **sync:** avoid building checkpoints to read client progress ([1049898](https://github.com/EastSun5566/articollab/commit/10498988d6a8eeac11c44964f6309dabb34614f2))

### Dependencies

* upgrade articulated to 1.4.0 ([7367a0e](https://github.com/EastSun5566/articollab/commit/7367a0ed296c1d9b9f9d15c3caa709353ed961e7))

## [0.7.1](https://github.com/EastSun5566/articollab/compare/v0.7.0...v0.7.1) (2026-11-21)

### Bug Fixes

* **sync:** preserve terminal states and cancellation boundaries ([581f1ea](https://github.com/EastSun5566/articollab/commit/581f1ea04f19c7db26f938c143d4e9d3162f4feb))
* **sync:** serialize stream admission and clean up aborted requests ([a6ef353](https://github.com/EastSun5566/articollab/commit/a6ef353977017ec2b00b92bf0c0e007e9726419e))

## [0.7.0](https://github.com/EastSun5566/articollab/compare/v0.6.0...v0.7.0) (2026-11-09)

### Features

* **sync:** push commits over server-sent events ([f95de6b](https://github.com/EastSun5566/articollab/commit/f95de6b1606a1ae9ab0287c7c723e234c6b202c2))

## [0.6.0](https://github.com/EastSun5566/articollab/compare/v0.5.0...v0.6.0) (2026-11-07)

### Features

* **client:** report own list sets discarded by deletes ([f4d2094](https://github.com/EastSun5566/articollab/commit/f4d209446bb23b07d32b7c053e43244fc9a16209))
* **server:** list open client sessions ([f6164cf](https://github.com/EastSun5566/articollab/commit/f6164cf9b0b213d3dae46aa549dc645329032779))
* **sync:** add a polling sync engine with HTTP transport and handler ([e91f5e4](https://github.com/EastSun5566/articollab/commit/e91f5e44750d8bdc4f220d069a15e948e5c77e97))

## [0.5.0](https://github.com/EastSun5566/articollab/compare/v0.4.0...v0.5.0) (2026-10-30)

### Features

* add opt-in List visible change subscriptions ([2fa6949](https://github.com/EastSun5566/articollab/commit/2fa69491afe4b102e52d6fccb8236fe8c71fc6fb))
* add stable Text and List cursors ([9d9ade1](https://github.com/EastSun5566/articollab/commit/9d9ade1aec15b462ea91b45fcf58dc7ce651c113))
* **examples:** add CodeMirror text editor prototype ([a0f3915](https://github.com/EastSun5566/articollab/commit/a0f3915e88722b1b2eeeba2d20767dd0f47b8ac6))

### Bug Fixes

* keep root lint independent of example dependencies ([1c7e232](https://github.com/EastSun5566/articollab/commit/1c7e23254c1b0381a3cf37bbb12cba986c0b3911))

## [0.4.0](https://github.com/EastSun5566/articollab/compare/v0.3.1...v0.4.0) (2026-10-21)

### Features

* add opt-in Text visible change subscriptions ([f0967ed](https://github.com/EastSun5566/articollab/commit/f0967ed73bfdce1194419f41c0870d89ea07b78f))

### Bug Fixes

* preserve surrogate boundaries in Text snapshots ([830c782](https://github.com/EastSun5566/articollab/commit/830c782fc640a2637de3156b9dad99b94e45858b))

## [0.3.1](https://github.com/EastSun5566/articollab/compare/v0.3.0...v0.3.1) (2026-10-19)

### Performance Improvements

* **client:** compare pending reconciliation at affected IDs ([21bfc08](https://github.com/EastSun5566/articollab/commit/21bfc087c1713372f32bc476e1f39890bb2a7ed4))

## [0.3.0](https://github.com/EastSun5566/articollab/compare/v0.2.0...v0.3.0) (2026-10-18)

### ⚠ BREAKING CHANGES

* All participating runtimes must support list/set before exchanging updates; 0.2 runtimes cannot decode the new operation.

### Features

* add stable-identity list updates ([853463c](https://github.com/EastSun5566/articollab/commit/853463cacd7df8eb15957c33289ef546022664fe))

### Bug Fixes

* **ci:** allow npm processing time and refresh beta docs ([cc34cf6](https://github.com/EastSun5566/articollab/commit/cc34cf66600b1d1ac1463062e6364de4ad17102a))
* validate text ranges and avoid redundant collection work ([3bb4b86](https://github.com/EastSun5566/articollab/commit/3bb4b86e607a61dad5fafdf64a183d3256e327d0))

## [0.3.0-beta.0](https://github.com/EastSun5566/articollab/compare/v0.2.0...v0.3.0-beta.0) (2026-10-15)

### ⚠ BREAKING CHANGES

* All participating runtimes must support list/set before exchanging updates; 0.2 runtimes cannot decode the new operation.

### Features

* add stable-identity list updates ([853463c](https://github.com/EastSun5566/articollab/commit/853463cacd7df8eb15957c33289ef546022664fe))

### Bug Fixes

* validate text ranges and avoid redundant collection work ([3bb4b86](https://github.com/EastSun5566/articollab/commit/3bb4b86e607a61dad5fafdf64a183d3256e327d0))

## 0.2.0 (2026-10-11)

### ⚠ BREAKING CHANGES

* new receive batches require canonical insertion namespaces by default. Set allowCustomClientNamespaces to true for application-owned incoming ID policy. Retained retries and trusted rejection preserve their original results.
* server submissions require an open issued ID; maxClients bounds open sessions; server checkpoints now use lastClientNumber and clients instead of replays. Old server checkpoints are rejected.

### Features

* add articulated-backed lists ([4057591](https://github.com/EastSun5566/articollab/commit/4057591bd88a71a345d1d73ae17fa658210c2b65))
* add articulated-backed text ([f72378f](https://github.com/EastSun5566/articollab/commit/f72378fb645d5a2f8e5da1f80bb3f9c82c04f130))
* add asynchronous wire resume example ([66bfebe](https://github.com/EastSun5566/articollab/commit/66bfebe6d3de3c6ee661abb9a3d791cf67e0cbdc))
* add bounded server commit catch-up ([2479222](https://github.com/EastSun5566/articollab/commit/24792222c4da3439937fc547b5cd09cd0189e0fb))
* add browser and server checkpoint recovery example ([bf2916e](https://github.com/EastSun5566/articollab/commit/bf2916ee0e3582671bb7178a5c2bfb3185656e76))
* add browser checkpoint reload recovery example ([2426a2e](https://github.com/EastSun5566/articollab/commit/2426a2e5ccb5704b4f97029f06b5b96477987984))
* add client checkpoint restore ([82dd231](https://github.com/EastSun5566/articollab/commit/82dd231ad91d7fcbee49c956c63cc8970bb98f8c))
* add client-side server reconciliation ([89d2876](https://github.com/EastSun5566/articollab/commit/89d287655e46264eed856c359800c52666788d58))
* add explicit server rejection and pending recovery ([ce5c5be](https://github.com/EastSun5566/articollab/commit/ce5c5be2fe01e8757f7be6d8ce5ed9e0c972a55e))
* add explicit server-issued client sessions ([d380a43](https://github.com/EastSun5566/articollab/commit/d380a4317604427b8d81d479497370ec16fc122b))
* add file-backed checkpoint recovery example ([20ba75b](https://github.com/EastSun5566/articollab/commit/20ba75b56ac50629dc5424232c83499c4a5ed02f))
* add file-backed HTTP recovery example ([bd307ef](https://github.com/EastSun5566/articollab/commit/bd307ef9080e50ed2fda7721e407e87b14001b81))
* add HTTP pending rejection recovery ([67a2766](https://github.com/EastSun5566/articollab/commit/67a2766da0119235f494d5690a29b279bd242094))
* add minimal HTTP sync example ([42aadb1](https://github.com/EastSun5566/articollab/commit/42aadb188b5ce5024af587357d0e577865be8881))
* add minimal in-memory resume workflow ([cad9431](https://github.com/EastSun5566/articollab/commit/cad9431768d4f00b88042cdfcc9b41ff686ca4cd))
* add minimal server runtime ([36e7d3b](https://github.com/EastSun5566/articollab/commit/36e7d3b06b6633fe641a1ab68f8d3cb8f617fed6))
* add opt-in client batch namespace guard ([53b6dbe](https://github.com/EastSun5566/articollab/commit/53b6dbe4a61c7ea40ff700db0d8754036633c3ef))
* add server batch policies ([c9d7c3e](https://github.com/EastSun5566/articollab/commit/c9d7c3e6ec7e59667f822fdba551282845eb9744))
* add server checkpoint restore ([9194af2](https://github.com/EastSun5566/articollab/commit/9194af2513f8f2b59fd18dea3a9b567837153afe))
* add server client capacity limit ([9ee0de9](https://github.com/EastSun5566/articollab/commit/9ee0de9c8f4a88274dd213e847563d600b031272))
* add server retry deduplication ([0c772d7](https://github.com/EastSun5566/articollab/commit/0c772d7d3b31c3dc2cbca77a6bd7ebd7d1301887))
* add snapshot hydration ([2f0ee2b](https://github.com/EastSun5566/articollab/commit/2f0ee2b56777ccb6956a06b5ddc9c8d195d63581))
* add strict wire decoding ([45451b8](https://github.com/EastSun5566/articollab/commit/45451b8a73708f17c206661d9fe47728e688064e))
* add typed optimistic value runtime ([617a8c9](https://github.com/EastSun5566/articollab/commit/617a8c9949abeaf92ab3f0c29b9e1736bbd9ea80))
* enforce incoming client insertion namespaces ([d3b62be](https://github.com/EastSun5566/articollab/commit/d3b62be9e978dd94f03282ab28f2d94e0c6099c4))
* expose pending replay conflicts ([a6e4631](https://github.com/EastSun5566/articollab/commit/a6e4631968f7d01653b193dabe25fd87e0d0e8e2))
* guard browser recovery document lineage ([913e2ee](https://github.com/EastSun5566/articollab/commit/913e2eed08a0fdc9177d2840510e3c5c3f513ee1))
* restore HTTP clients from checkpoints ([1197c70](https://github.com/EastSun5566/articollab/commit/1197c7010a64a1fc7bac1562fb6c10bc22435880))

### Bug Fixes

* **ci:** wait for published registry metadata ([6d1f554](https://github.com/EastSun5566/articollab/commit/6d1f5540cb2d79931d399a0f459b6abdbdfabf9d))
* handle deeply nested JSON without recursive traversal ([ed49d36](https://github.com/EastSun5566/articollab/commit/ed49d36d6131363558ed63d42245d36a9e1c3e29))
* validate local JSON payloads before mutation ([a4b0c52](https://github.com/EastSun5566/articollab/commit/a4b0c5205f660350429987c303549fc6e03f0083))

## 0.2.0-beta.1 (2026-10-10)

### ⚠ BREAKING CHANGES

* new receive batches require canonical insertion namespaces by default. Set allowCustomClientNamespaces to true for application-owned incoming ID policy. Retained retries and trusted rejection preserve their original results.
* server submissions require an open issued ID; maxClients bounds open sessions; server checkpoints now use lastClientNumber and clients instead of replays. Old server checkpoints are rejected.

### Features

* add articulated-backed lists ([4057591](https://github.com/EastSun5566/articollab/commit/4057591bd88a71a345d1d73ae17fa658210c2b65))
* add articulated-backed text ([f72378f](https://github.com/EastSun5566/articollab/commit/f72378fb645d5a2f8e5da1f80bb3f9c82c04f130))
* add asynchronous wire resume example ([66bfebe](https://github.com/EastSun5566/articollab/commit/66bfebe6d3de3c6ee661abb9a3d791cf67e0cbdc))
* add bounded server commit catch-up ([2479222](https://github.com/EastSun5566/articollab/commit/24792222c4da3439937fc547b5cd09cd0189e0fb))
* add browser and server checkpoint recovery example ([bf2916e](https://github.com/EastSun5566/articollab/commit/bf2916ee0e3582671bb7178a5c2bfb3185656e76))
* add browser checkpoint reload recovery example ([2426a2e](https://github.com/EastSun5566/articollab/commit/2426a2e5ccb5704b4f97029f06b5b96477987984))
* add client checkpoint restore ([82dd231](https://github.com/EastSun5566/articollab/commit/82dd231ad91d7fcbee49c956c63cc8970bb98f8c))
* add client-side server reconciliation ([89d2876](https://github.com/EastSun5566/articollab/commit/89d287655e46264eed856c359800c52666788d58))
* add explicit server rejection and pending recovery ([ce5c5be](https://github.com/EastSun5566/articollab/commit/ce5c5be2fe01e8757f7be6d8ce5ed9e0c972a55e))
* add explicit server-issued client sessions ([d380a43](https://github.com/EastSun5566/articollab/commit/d380a4317604427b8d81d479497370ec16fc122b))
* add file-backed checkpoint recovery example ([20ba75b](https://github.com/EastSun5566/articollab/commit/20ba75b56ac50629dc5424232c83499c4a5ed02f))
* add file-backed HTTP recovery example ([bd307ef](https://github.com/EastSun5566/articollab/commit/bd307ef9080e50ed2fda7721e407e87b14001b81))
* add HTTP pending rejection recovery ([67a2766](https://github.com/EastSun5566/articollab/commit/67a2766da0119235f494d5690a29b279bd242094))
* add minimal HTTP sync example ([42aadb1](https://github.com/EastSun5566/articollab/commit/42aadb188b5ce5024af587357d0e577865be8881))
* add minimal in-memory resume workflow ([cad9431](https://github.com/EastSun5566/articollab/commit/cad9431768d4f00b88042cdfcc9b41ff686ca4cd))
* add minimal server runtime ([36e7d3b](https://github.com/EastSun5566/articollab/commit/36e7d3b06b6633fe641a1ab68f8d3cb8f617fed6))
* add opt-in client batch namespace guard ([53b6dbe](https://github.com/EastSun5566/articollab/commit/53b6dbe4a61c7ea40ff700db0d8754036633c3ef))
* add server batch policies ([c9d7c3e](https://github.com/EastSun5566/articollab/commit/c9d7c3e6ec7e59667f822fdba551282845eb9744))
* add server checkpoint restore ([9194af2](https://github.com/EastSun5566/articollab/commit/9194af2513f8f2b59fd18dea3a9b567837153afe))
* add server client capacity limit ([9ee0de9](https://github.com/EastSun5566/articollab/commit/9ee0de9c8f4a88274dd213e847563d600b031272))
* add server retry deduplication ([0c772d7](https://github.com/EastSun5566/articollab/commit/0c772d7d3b31c3dc2cbca77a6bd7ebd7d1301887))
* add snapshot hydration ([2f0ee2b](https://github.com/EastSun5566/articollab/commit/2f0ee2b56777ccb6956a06b5ddc9c8d195d63581))
* add strict wire decoding ([45451b8](https://github.com/EastSun5566/articollab/commit/45451b8a73708f17c206661d9fe47728e688064e))
* add typed optimistic value runtime ([617a8c9](https://github.com/EastSun5566/articollab/commit/617a8c9949abeaf92ab3f0c29b9e1736bbd9ea80))
* enforce incoming client insertion namespaces ([d3b62be](https://github.com/EastSun5566/articollab/commit/d3b62be9e978dd94f03282ab28f2d94e0c6099c4))
* expose pending replay conflicts ([a6e4631](https://github.com/EastSun5566/articollab/commit/a6e4631968f7d01653b193dabe25fd87e0d0e8e2))
* guard browser recovery document lineage ([913e2ee](https://github.com/EastSun5566/articollab/commit/913e2eed08a0fdc9177d2840510e3c5c3f513ee1))
* restore HTTP clients from checkpoints ([1197c70](https://github.com/EastSun5566/articollab/commit/1197c7010a64a1fc7bac1562fb6c10bc22435880))

### Bug Fixes

* **ci:** wait for published registry metadata ([6d1f554](https://github.com/EastSun5566/articollab/commit/6d1f5540cb2d79931d399a0f459b6abdbdfabf9d))
* handle deeply nested JSON without recursive traversal ([ed49d36](https://github.com/EastSun5566/articollab/commit/ed49d36d6131363558ed63d42245d36a9e1c3e29))
* validate local JSON payloads before mutation ([a4b0c52](https://github.com/EastSun5566/articollab/commit/a4b0c5205f660350429987c303549fc6e03f0083))

## 0.2.0-beta.0 (2026-10-09)

### ⚠ BREAKING CHANGES

* server submissions require an open issued ID; maxClients bounds open sessions; server checkpoints now use lastClientNumber and clients instead of replays. Old server checkpoints are rejected.

### Features

* add articulated-backed lists ([4057591](https://github.com/EastSun5566/articollab/commit/4057591bd88a71a345d1d73ae17fa658210c2b65))
* add articulated-backed text ([f72378f](https://github.com/EastSun5566/articollab/commit/f72378fb645d5a2f8e5da1f80bb3f9c82c04f130))
* add asynchronous wire resume example ([66bfebe](https://github.com/EastSun5566/articollab/commit/66bfebe6d3de3c6ee661abb9a3d791cf67e0cbdc))
* add bounded server commit catch-up ([2479222](https://github.com/EastSun5566/articollab/commit/24792222c4da3439937fc547b5cd09cd0189e0fb))
* add browser and server checkpoint recovery example ([bf2916e](https://github.com/EastSun5566/articollab/commit/bf2916ee0e3582671bb7178a5c2bfb3185656e76))
* add browser checkpoint reload recovery example ([2426a2e](https://github.com/EastSun5566/articollab/commit/2426a2e5ccb5704b4f97029f06b5b96477987984))
* add client checkpoint restore ([82dd231](https://github.com/EastSun5566/articollab/commit/82dd231ad91d7fcbee49c956c63cc8970bb98f8c))
* add client-side server reconciliation ([89d2876](https://github.com/EastSun5566/articollab/commit/89d287655e46264eed856c359800c52666788d58))
* add explicit server rejection and pending recovery ([ce5c5be](https://github.com/EastSun5566/articollab/commit/ce5c5be2fe01e8757f7be6d8ce5ed9e0c972a55e))
* add explicit server-issued client sessions ([d380a43](https://github.com/EastSun5566/articollab/commit/d380a4317604427b8d81d479497370ec16fc122b))
* add file-backed checkpoint recovery example ([20ba75b](https://github.com/EastSun5566/articollab/commit/20ba75b56ac50629dc5424232c83499c4a5ed02f))
* add file-backed HTTP recovery example ([bd307ef](https://github.com/EastSun5566/articollab/commit/bd307ef9080e50ed2fda7721e407e87b14001b81))
* add HTTP pending rejection recovery ([67a2766](https://github.com/EastSun5566/articollab/commit/67a2766da0119235f494d5690a29b279bd242094))
* add minimal HTTP sync example ([42aadb1](https://github.com/EastSun5566/articollab/commit/42aadb188b5ce5024af587357d0e577865be8881))
* add minimal in-memory resume workflow ([cad9431](https://github.com/EastSun5566/articollab/commit/cad9431768d4f00b88042cdfcc9b41ff686ca4cd))
* add minimal server runtime ([36e7d3b](https://github.com/EastSun5566/articollab/commit/36e7d3b06b6633fe641a1ab68f8d3cb8f617fed6))
* add opt-in client batch namespace guard ([53b6dbe](https://github.com/EastSun5566/articollab/commit/53b6dbe4a61c7ea40ff700db0d8754036633c3ef))
* add server batch policies ([c9d7c3e](https://github.com/EastSun5566/articollab/commit/c9d7c3e6ec7e59667f822fdba551282845eb9744))
* add server checkpoint restore ([9194af2](https://github.com/EastSun5566/articollab/commit/9194af2513f8f2b59fd18dea3a9b567837153afe))
* add server client capacity limit ([9ee0de9](https://github.com/EastSun5566/articollab/commit/9ee0de9c8f4a88274dd213e847563d600b031272))
* add server retry deduplication ([0c772d7](https://github.com/EastSun5566/articollab/commit/0c772d7d3b31c3dc2cbca77a6bd7ebd7d1301887))
* add snapshot hydration ([2f0ee2b](https://github.com/EastSun5566/articollab/commit/2f0ee2b56777ccb6956a06b5ddc9c8d195d63581))
* add strict wire decoding ([45451b8](https://github.com/EastSun5566/articollab/commit/45451b8a73708f17c206661d9fe47728e688064e))
* add typed optimistic value runtime ([617a8c9](https://github.com/EastSun5566/articollab/commit/617a8c9949abeaf92ab3f0c29b9e1736bbd9ea80))
* expose pending replay conflicts ([a6e4631](https://github.com/EastSun5566/articollab/commit/a6e4631968f7d01653b193dabe25fd87e0d0e8e2))
* guard browser recovery document lineage ([913e2ee](https://github.com/EastSun5566/articollab/commit/913e2eed08a0fdc9177d2840510e3c5c3f513ee1))
* restore HTTP clients from checkpoints ([1197c70](https://github.com/EastSun5566/articollab/commit/1197c7010a64a1fc7bac1562fb6c10bc22435880))

### Bug Fixes

* **ci:** wait for published registry metadata ([6d1f554](https://github.com/EastSun5566/articollab/commit/6d1f5540cb2d79931d399a0f459b6abdbdfabf9d))
* handle deeply nested JSON without recursive traversal ([ed49d36](https://github.com/EastSun5566/articollab/commit/ed49d36d6131363558ed63d42245d36a9e1c3e29))
* validate local JSON payloads before mutation ([a4b0c52](https://github.com/EastSun5566/articollab/commit/a4b0c5205f660350429987c303549fc6e03f0083))

## 0.1.0-beta.1 (2026-10-08)

### Features

* add articulated-backed lists ([4057591](https://github.com/EastSun5566/articollab/commit/4057591bd88a71a345d1d73ae17fa658210c2b65))
* add articulated-backed text ([f72378f](https://github.com/EastSun5566/articollab/commit/f72378fb645d5a2f8e5da1f80bb3f9c82c04f130))
* add asynchronous wire resume example ([66bfebe](https://github.com/EastSun5566/articollab/commit/66bfebe6d3de3c6ee661abb9a3d791cf67e0cbdc))
* add bounded server commit catch-up ([2479222](https://github.com/EastSun5566/articollab/commit/24792222c4da3439937fc547b5cd09cd0189e0fb))
* add browser and server checkpoint recovery example ([bf2916e](https://github.com/EastSun5566/articollab/commit/bf2916ee0e3582671bb7178a5c2bfb3185656e76))
* add browser checkpoint reload recovery example ([2426a2e](https://github.com/EastSun5566/articollab/commit/2426a2e5ccb5704b4f97029f06b5b96477987984))
* add client checkpoint restore ([82dd231](https://github.com/EastSun5566/articollab/commit/82dd231ad91d7fcbee49c956c63cc8970bb98f8c))
* add client-side server reconciliation ([89d2876](https://github.com/EastSun5566/articollab/commit/89d287655e46264eed856c359800c52666788d58))
* add explicit server rejection and pending recovery ([ce5c5be](https://github.com/EastSun5566/articollab/commit/ce5c5be2fe01e8757f7be6d8ce5ed9e0c972a55e))
* add file-backed checkpoint recovery example ([20ba75b](https://github.com/EastSun5566/articollab/commit/20ba75b56ac50629dc5424232c83499c4a5ed02f))
* add file-backed HTTP recovery example ([bd307ef](https://github.com/EastSun5566/articollab/commit/bd307ef9080e50ed2fda7721e407e87b14001b81))
* add HTTP pending rejection recovery ([67a2766](https://github.com/EastSun5566/articollab/commit/67a2766da0119235f494d5690a29b279bd242094))
* add minimal HTTP sync example ([42aadb1](https://github.com/EastSun5566/articollab/commit/42aadb188b5ce5024af587357d0e577865be8881))
* add minimal in-memory resume workflow ([cad9431](https://github.com/EastSun5566/articollab/commit/cad9431768d4f00b88042cdfcc9b41ff686ca4cd))
* add minimal server runtime ([36e7d3b](https://github.com/EastSun5566/articollab/commit/36e7d3b06b6633fe641a1ab68f8d3cb8f617fed6))
* add server batch policies ([c9d7c3e](https://github.com/EastSun5566/articollab/commit/c9d7c3e6ec7e59667f822fdba551282845eb9744))
* add server checkpoint restore ([9194af2](https://github.com/EastSun5566/articollab/commit/9194af2513f8f2b59fd18dea3a9b567837153afe))
* add server client capacity limit ([9ee0de9](https://github.com/EastSun5566/articollab/commit/9ee0de9c8f4a88274dd213e847563d600b031272))
* add server retry deduplication ([0c772d7](https://github.com/EastSun5566/articollab/commit/0c772d7d3b31c3dc2cbca77a6bd7ebd7d1301887))
* add snapshot hydration ([2f0ee2b](https://github.com/EastSun5566/articollab/commit/2f0ee2b56777ccb6956a06b5ddc9c8d195d63581))
* add strict wire decoding ([45451b8](https://github.com/EastSun5566/articollab/commit/45451b8a73708f17c206661d9fe47728e688064e))
* add typed optimistic value runtime ([617a8c9](https://github.com/EastSun5566/articollab/commit/617a8c9949abeaf92ab3f0c29b9e1736bbd9ea80))
* expose pending replay conflicts ([a6e4631](https://github.com/EastSun5566/articollab/commit/a6e4631968f7d01653b193dabe25fd87e0d0e8e2))
* guard browser recovery document lineage ([913e2ee](https://github.com/EastSun5566/articollab/commit/913e2eed08a0fdc9177d2840510e3c5c3f513ee1))
* restore HTTP clients from checkpoints ([1197c70](https://github.com/EastSun5566/articollab/commit/1197c7010a64a1fc7bac1562fb6c10bc22435880))

### Bug Fixes

* handle deeply nested JSON without recursive traversal ([ed49d36](https://github.com/EastSun5566/articollab/commit/ed49d36d6131363558ed63d42245d36a9e1c3e29))
* validate local JSON payloads before mutation ([a4b0c52](https://github.com/EastSun5566/articollab/commit/a4b0c5205f660350429987c303549fc6e03f0083))
