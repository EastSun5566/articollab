# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

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
* server submissions require an open issued ID; maxClients bounds open sessions; server checkpoints now use lastClientNumber and clients instead of replays. Old server checkpoints are rejected. Prepare the unpublished 0.2.0-beta.0 baseline.

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
* server submissions require an open issued ID; maxClients bounds open sessions; server checkpoints now use lastClientNumber and clients instead of replays. Old server checkpoints are rejected. Prepare the unpublished 0.2.0-beta.0 baseline.

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

* server submissions require an open issued ID; maxClients bounds open sessions; server checkpoints now use lastClientNumber and clients instead of replays. Old server checkpoints are rejected. Prepare the unpublished 0.2.0-beta.0 baseline.

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
