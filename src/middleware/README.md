# middleware

Middleware for `@xmpp/client` and `@xmpp/component`.

Supports Node.js and browsers.

This module is part of this repository's internal package set.

## Usage

```js
import { Client } from "@xmpp/client";
import middleware from "@xmpp/middleware";

const client = new Client();
const app = middleware({ entity: client });
```

### use

The `use` method registers a middleware for incoming stanzas.

```js
app.use((ctx, next) => {});
```

### filter

The `filter` method registers a middleware for outgoing stanzas.

```js
app.filter((ctx, next) => {});
```
