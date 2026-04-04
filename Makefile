.PHONY: setup lint test ci unit e2e clean start stop restart bundlesize bundle size ncu

setup:
	node packages/xmpp.js/script.js
	bun install
	cd packages/xmpp.js/ && bun run prepublish
	make bundle

lint:
	bunx eslint --cache .

format:
	bunx eslint --cache --fix .

test:
	cd packages/xmpp.js/ && bun run prepublish
	bun install
	make bundle
	bunx jest
	make lint
	make bundlesize

ci:
	bun install
	make unit
	make lint
	make restart
	bunx lerna run prepublish
	make bundle
	make e2e
	make bundlesize

unit:
	bun run test

e2e:
	$(warning e2e tests require prosody >= 0.13 and luarocks)
	cd server && prosodyctl --config prosody.cfg.lua install mod_sasl2 > /dev/null
	cd server && prosodyctl --config prosody.cfg.lua install mod_sasl2_bind2 > /dev/null
	cd server && prosodyctl --config prosody.cfg.lua install mod_sasl2_sm > /dev/null
	cd server && prosodyctl --config prosody.cfg.lua install mod_sasl2_fast > /dev/null
	bun run e2e
	node --test browser.test.js

clean:
	make stop
	rm -f server/localhost.key
	rm -f server/localhost.crt
	rm -f server/prosody.err
	rm -f server/prosody.log
	rm -f server/prosody.pid
	rm -rf server/modules
	rm -rf server/.cache
	bunx lerna clean --yes
	rm -rf node_modules/
	rm -f packages/*/dist/*.js
	rm -f lerna-debug.log

start:
	./server/ctl.js start

stop:
	./server/ctl.js stop

restart:
	./server/ctl.js restart

bundlesize:
	node test/bundlesize.js

bundle:
	bunx rollup -c rollup.config.js

size:
	make bundle
	make bundlesize

ncu:
	ncu -u && bunx lerna exec ncu -u
