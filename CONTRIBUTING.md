# Development

## Setup

bun is required for development - update with `bun upgrade`

```sh
git clone git@github.com:janilowski/xmpp-client.git
cd xmpp-client
bun install
bun run build
```

## Making changes

At that point you can make changes to the xmpp-client code and run tests with

```sh
bun run test
```

## Submitting

When submitting a pull request, additional tests will be run on GitHub actions.
In most cases it shouldn't be necessary but if they fail, you can run them locally after installing prosody >= 0.13 with

```sh
bun run test:e2e
```

## Design philosophy

xmpp-client is an XMPP client library. Learning about XMPP is required to use it.
