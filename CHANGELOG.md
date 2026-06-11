# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and the format is based on
[Keep a Changelog](https://keepachangelog.com/). During `0.x`, minor versions may include
breaking changes. This file is maintained automatically by release-please.

## [0.10.1](https://github.com/sean35mm/weaver/compare/v0.10.0...v0.10.1) (2026-06-11)


### Bug Fixes

* resolve harness labels via ancestry and render explicit session names ([0903c34](https://github.com/sean35mm/weaver/commit/0903c34d6eaf805753a2dc35930edc9c5a2c9476))

## [0.10.0](https://github.com/sean35mm/weaver/compare/v0.9.0...v0.10.0) (2026-06-09)


### Features

* add claude code hooks for structural, advisory coordination ([b314b94](https://github.com/sean35mm/weaver/commit/b314b9461ea78dac55dc55b35a18b1ffcb81891a))
* add weaver forget for agent-driven note curation ([dc74274](https://github.com/sean35mm/weaver/commit/dc7427435f8ba90d607b4f2e7e040848fcad4d28))
* clarify init scopes and automatic store creation ([04a976d](https://github.com/sean35mm/weaver/commit/04a976dae4ab2e9f7a36c6bf95a33f7a5d26d299))
* complete note lifecycle with ids and superseded filtering ([a1ad1a2](https://github.com/sean35mm/weaver/commit/a1ad1a241db3c31710054d1987ec2decd4346736))


### Bug Fixes

* preserve user hooks in shared matcher groups, reject conflicting init hook flags ([933010f](https://github.com/sean35mm/weaver/commit/933010fbc2374d6ba7ba39375ee4cc83ac499287))
* rate-limit repeated pre-edit advisories ([1aaaffc](https://github.com/sean35mm/weaver/commit/1aaaffc32014ea08225f90e94cd14acc22a8e20c))
* surface unpinned notes in quiet repos, honor tuned ttl in doctor, stop junk store creation ([0102fbd](https://github.com/sean35mm/weaver/commit/0102fbdf8242a0d7a210512ac9bccf4d5044cd82))

## [0.9.0](https://github.com/sean35mm/weaver/compare/v0.8.0...v0.9.0) (2026-06-08)


### Features

* add global init instruction scope ([0b7312b](https://github.com/sean35mm/weaver/commit/0b7312bb536912b7975f31d59aed86b6a27acbd1))

## [0.8.0](https://github.com/sean35mm/weaver/compare/v0.7.0...v0.8.0) (2026-06-05)


### Features

* improve terminal output layout ([a96ef65](https://github.com/sean35mm/weaver/commit/a96ef654fae7bf63a89e95296af0ad8297a892a9))

## [0.7.0](https://github.com/sean35mm/weaver/compare/v0.6.0...v0.7.0) (2026-06-05)


### Features

* add soft terminal colors ([e9c4e03](https://github.com/sean35mm/weaver/commit/e9c4e03d56a6da0d0425324caf2f69257bab4442))

## [0.6.0](https://github.com/sean35mm/weaver/compare/v0.5.1...v0.6.0) (2026-06-05)


### Features

* add bounded preflight checks ([c03ccfc](https://github.com/sean35mm/weaver/commit/c03ccfc3035522538f3ff46cbcb578441a22ef52))

## [0.5.1](https://github.com/sean35mm/weaver/compare/v0.5.0...v0.5.1) (2026-06-02)


### Bug Fixes

* harden release and coordination flows ([f6cfd1f](https://github.com/sean35mm/weaver/commit/f6cfd1f3b0fc8a741c34b6a4f56814478f246f61))

## [0.5.0](https://github.com/sean35mm/weaver/compare/v0.4.0...v0.5.0) (2026-06-01)


### Features

* **docs:** add roadmap page, split hero, and font system ([50bed26](https://github.com/sean35mm/weaver/commit/50bed266f5afa9fe37965662753a287360840bee))

## [0.4.0](https://github.com/sean35mm/weaver/compare/v0.3.0...v0.4.0) (2026-06-01)


### Features

* 15-minute default session TTL and heartbeat refresh on check ([b99aeb9](https://github.com/sean35mm/weaver/commit/b99aeb9995e7995a7fd08335518f6b48cc7c440a))

## [0.3.0](https://github.com/sean35mm/weaver/compare/v0.2.0...v0.3.0) (2026-06-01)


### Features

* add 'weaver uninstall' command ([268f15c](https://github.com/sean35mm/weaver/commit/268f15c49ae7be8928bb0813c3e5cbf64df3276c))

## [0.2.0](https://github.com/sean35mm/weaver/compare/v0.1.0...v0.2.0) (2026-06-01)


### Features

* add 'weaver upgrade' (self-updating binary) and make curl the primary install ([8b6d37d](https://github.com/sean35mm/weaver/commit/8b6d37d8cf6935bad27d310448b7778a990fc21c))

## 0.1.0 (2026-06-01)

Initial release — CLI-first coordination layer for multiple coding agents: store + identity
ladder, the full verb set, three-tier conflict detection, lifecycle commands
(`init`/`disable`/`enable`/`deinit`), tunable config, and the `dashboard`/`watch` viewers.
