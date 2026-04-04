# xmpp-client

> An XMPP client library for the modern web.

[XMPP](https://xmpp.org/about-xmpp/technology-overview/) is the Extensible Messaging and Presence Protocol, a set of open technologies for instant messaging, presence, multi-party chat, voice and video calls, collaboration, lightweight middleware, content syndication, and generalized routing of XML data.

`xmpp-client` is a JavaScript library to use XMPP in a web browser.

## Getting started

```sh
bun install
bun run build
````

## goals

### client only

This project is focused on the web client use case.

The goal is to provide a library that application developers can use to build their own XMPP UI in the browser (or perhaps as an app using technologies like React Native).

### standards compliance

This fork is meant to push the client towards stronger XMPP standards compliance. The aim is to first comply with all "core" requirements.

### modern

This project uses modern JavaScript dev tooling and targets modern environments.

It is ESM-first, uses Bun for development, Rolldown for bundling, and is being moved toward a simple internal architecture of a single, small package (instead of a large monorepo with lots of packages that sometimes have more lines in `package.json`s than actual code)

### small

Bundle size is constantly measured during development. The current goal is to keep it under 13 KB (gzipped).

This project aims to stay lean, avoid unnecessary dependencies, and keep the default browser client bundle as small as reasonably possible.

## Status

This is an active fork of `xmpp.js` with a narrower scope:

* browser client only
* standards-focused direction
* modernized tooling
* lower architectural and dependency overhead

I'm currently developing this myself (Jan Iłowski) in my spare time, trying to do the best job I can. Please contribute to this project too if you can!
