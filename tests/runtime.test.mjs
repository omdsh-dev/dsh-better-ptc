/** Real installed Node PTC worker coverage. Run with DSH_PACKAGE_ROOT set. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { BetterPtc } from '../src/index.js'

const hostRoot = process.env.DSH_PACKAGE_ROOT

for (const config of [
  { executionMode: 'per-call' },
  { executionMode: 'persistent-in-memory' },
  { executionMode: 'vm-script', scriptPersistence: false },
  { executionMode: 'vm-script', scriptPersistence: true },
]) test('installed Node runtime ' + JSON.stringify(config), { timeout: 45000, skip: !hostRoot && 'Set DSH_PACKAGE_ROOT to the installed @deepseek-ai/dsh package' }, async (t) => {
  const requireHost = createRequire(join(hostRoot, 'package.json'))
  assert.equal(requireHost(join(hostRoot, 'package.json')).version, '0.2.2-rc.2')
  const load = name => import(pathToFileURL(requireHost.resolve('@deepseek-ai/' + name)))
  const { Context } = await load('cordis')
  const { default: LocalFileSystem } = await load('dsh-fs-local')
  const { default: LocalSubprocessRuntime } = await load('dsh-subprocess-local')
  const { NodePtcRuntime } = await load('dsh-ptc-runtime-node')

  const fixture = async (t, registerTools = true) => {
    const ctx = new Context()
    new LocalFileSystem(ctx, LocalFileSystem.Config({ cwd: process.cwd() }))
    new LocalSubprocessRuntime(ctx)
    const runtime = new NodePtcRuntime(ctx, NodePtcRuntime.Config(config))
    const original = Object.getPrototypeOf(runtime).run
    const fiber = await ctx.plugin(BetterPtc)
    const exemption = ctx.betterPtc
    if (registerTools) {
      exemption.register('wait_subagent')
      exemption.register('ask_user_question')
    }
    t.after(async () => {
      await ctx.fiber.dispose()
    })
    const owner = {}
    const run = (program, functions, timeoutMs = 400, signal, extra = {}) => runtime.run({
      program: config.executionMode === 'per-call' ? program : program.replaceAll('return ', ''),
      stateOwner: owner,
      bindings: [{ global: 'tools', functions }],
      cwd: process.cwd(),
      timeoutMs,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: process.cwd() },
      ...(signal === undefined ? {} : { signal }),
      ...extra,
    })
    return Object.assign(run, { runtime, ctx, owner, exemption, fiber, original })
  }

  for (const name of ['wait_subagent', 'ask_user_question']) {
    await t.test(name + ' outlasts the program budget in a real worker', async (t) => {
      const run = await fixture(t)
      const start = Date.now()
      const result = await run('return await tools.' + name + '({})', {
        [name]: async () => { await delay(650); return name + '-done' },
      })
      assert.equal(result.error, undefined)
      assert.equal(result.value, name + '-done')
      assert.ok(Date.now() - start >= 650)
    })
  }

  for (const approved of [true, false]) {
    await t.test('plan decision stays pending without ask/subagent and returns approved=' + approved, async (t) => {
      const run = await fixture(t, false)
      const entered = Promise.withResolvers()
      const decision = Promise.withResolvers()
      t.after(() => decision.resolve({ approved: false }))
      let settled = false
      const pending = run('return await tools.exit_plan_mode({})', {
        exit_plan_mode: () => { entered.resolve(); return decision.promise },
      }).finally(() => { settled = true })
      await entered.promise
      await delay(650)
      assert.equal(settled, false, 'a pending decision must not time out or default')
      decision.resolve({ approved })
      const result = await pending
      assert.equal(result.error, undefined)
      assert.deepEqual(result.value, { approved })
    })
  }

  await t.test('a rejected exempt binding resumes the deadline', async (t) => {
    const run = await fixture(t)
    const result = await run('try { await tools.wait_subagent({}) } catch (error) { console.log(error.message) }; while (true) {}', {
      wait_subagent: async () => { await delay(650); throw new Error('decision failed') },
    })
    assert.equal(result.error?.kind, 'timeout')
    assert.ok(result.logs.some(line => line.includes('decision failed')))
  })

  await t.test('a runtime exception after a wait remains a runtime failure', async (t) => {
    const run = await fixture(t)
    const result = await run('await tools.wait_subagent({}); throw new Error("program failed")', {
      wait_subagent: async () => { await delay(650); return null },
    })
    assert.notEqual(result.error?.kind, 'timeout')
    assert.match(result.error?.message, /program failed/)
  })

  await t.test('service unload aborts a pending plan and restores exactly one prototype layer', async (t) => {
    const run = await fixture(t, false)
    const entered = Promise.withResolvers()
    const decision = Promise.withResolvers()
    t.after(() => decision.resolve({ approved: false }))
    const wrapped = Object.getPrototypeOf(run.runtime).run
    const unregister = run.exemption.register('wait_subagent')
    assert.equal(Object.getPrototypeOf(run.runtime).run, wrapped)
    unregister()
    assert.equal(Object.getPrototypeOf(run.runtime).run, wrapped, 'built-in plan registration remains')
    const pending = run('return await tools.exit_plan_mode({})', {
      exit_plan_mode: () => { entered.resolve(); return decision.promise },
    })
    await entered.promise
    await run.fiber.dispose()
    assert.equal(Object.getPrototypeOf(run.runtime).run, run.original)
    const result = await pending
    assert.equal(result.error?.kind, 'abort')
    decision.resolve({ approved: true })
    const next = await run('return 42', {})
    assert.equal(next.value, 42, 'unloading the wrapper does not dispose the runtime')
  })

  await t.test('owner state, release and timeout recovery follow runtime persistence', async (t) => {
    const run = await fixture(t)
    const functions = { wait_subagent: async () => 'ready' }
    assert.equal((await run('globalThis.ownerValue = 17; return globalThis.ownerValue', functions)).value, 17)
    assert.equal((await run('return typeof globalThis.ownerValue', functions)).value, run.runtime.retainsState ? 'number' : 'undefined')
    assert.equal((await run('return typeof globalThis.ownerValue', functions, 400, undefined, { stateOwner: {} })).value, 'undefined')
    await run.runtime.release(run.owner)
    assert.equal((await run('return typeof globalThis.ownerValue', functions)).value, 'undefined')
    await run('globalThis.ownerValue = 23; return 23', functions)
    const failed = await run('while (true) {}', functions)
    assert.equal(failed.error?.kind, 'timeout')
    assert.equal((await run('return typeof globalThis.ownerValue', functions)).value, 'undefined')
  })

  await t.test('release during a retained pending plan stops its owner and clears state', async (t) => {
    const run = await fixture(t, false)
    if (!run.runtime.retainsState) {
      await run.runtime.release(run.owner)
      assert.equal((await run('return 42', {})).value, 42)
      return
    }
    await run('globalThis.releaseValue = 1; return 1', {})
    const entered = Promise.withResolvers()
    const decision = Promise.withResolvers()
    t.after(() => decision.resolve({ approved: false }))
    const pending = run('return await tools.exit_plan_mode({})', {
      exit_plan_mode: () => { entered.resolve(); return decision.promise },
    })
    await entered.promise
    await run.runtime.release(run.owner)
    const result = await pending
    assert.ok(result.error, 'releasing the owner cannot approve the pending plan')
    assert.match(result.error.message, /retained variables were cleared/)
    assert.equal((await run('return typeof globalThis.releaseValue', {})).value, 'undefined')
  })

  await t.test('retained owner requires release before changing policy', async (t) => {
    const run = await fixture(t)
    const functions = { wait_subagent: async () => 'unused' }
    await run('globalThis.policyValue = 1; return 1', functions)
    // rc.2 keeps launch-time additional roots without rejecting, so exercise a
    // real policy change (workspace root) instead.
    const changed = { sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: join(process.cwd(), 'policy-change') } }
    if (run.runtime.retainsState) {
      await assert.rejects(run('return 42', functions, 400, undefined, changed), /release.*before changing its sandbox policy/)
      assert.equal((await run('return globalThis.policyValue', functions)).value, 1)
    }
    await run.runtime.release(run.owner)
    assert.equal((await run('return typeof globalThis.policyValue', functions, 400, undefined, changed)).value, 'undefined')
  })

  await t.test('same-owner concurrency obeys runtime policy without sharing paused deadlines', async (t) => {
    const run = await fixture(t)
    const entered = Promise.withResolvers()
    const finish = Promise.withResolvers()
    t.after(() => finish.resolve('done'))
    const first = run('return await tools.wait_subagent({})', {
      wait_subagent: () => { entered.resolve(); return finish.promise },
    })
    await entered.promise
    if (run.runtime.retainsState) {
      await assert.rejects(run('return 2', {}), /concurrent runs/)
    } else {
      assert.equal((await run('return 2', {})).value, 2)
    }
    finish.resolve('done')
    assert.equal((await first).value, 'done')
  })

  await t.test('runtime disposal interrupts an exempt plan without approving it', async (t) => {
    const run = await fixture(t, false)
    const entered = Promise.withResolvers()
    const decision = Promise.withResolvers()
    t.after(() => decision.resolve({ approved: false }))
    const pending = run('return await tools.exit_plan_mode({})', {
      exit_plan_mode: () => { entered.resolve(); return decision.promise },
    })
    await entered.promise
    await run.ctx.fiber.dispose()
    assert.equal((await pending).error?.kind, 'abort')
    await assert.rejects(run('return 42', {}), /after disposal/)
  })

  await t.test('session sandbox-mode change cancels a pending exempt plan', async (t) => {
    const run = await fixture(t, false)
    await run('globalThis.permissionValue = 1; return 1', {}, 400, undefined, { sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: process.cwd(), sessionId: 'ptc-policy-test' } })
    const entered = Promise.withResolvers()
    const decision = Promise.withResolvers()
    t.after(() => decision.resolve({ approved: false }))
    const pending = run('return await tools.exit_plan_mode({})', {
      exit_plan_mode: () => { entered.resolve(); return decision.promise },
    }, 400, undefined, { sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: process.cwd(), sessionId: 'ptc-policy-test' } })
    await entered.promise
    run.ctx.emit('session/event', { id: 'other-session' }, { type: 'sandbox/mode', data: { mode: 'read-only' } })
    run.ctx.emit('session/event', { id: 'ptc-policy-test' }, { type: 'sandbox/mode', data: { mode: 'read-only' } })
    const result = await pending
    assert.equal(result.error?.kind, 'abort')
    if (run.runtime.retainsState) assert.match(result.error.message, /retained variables were cleared/)
    const recovered = await run('return typeof globalThis.permissionValue', {})
    assert.equal(recovered.value, 'undefined')
  })

  await t.test('namespace copying preserves a tool named __proto__', async (t) => {
    const run = await fixture(t)
    const functions = Object.create(null)
    Object.defineProperty(functions, '__proto__', {
      enumerable: true,
      value: async () => 'special-tool-result',
    })
    functions.wait_subagent = async () => 'unused'
    const result = await run("return await tools['__proto__']({})", functions)
    assert.equal(result.error, undefined)
    assert.equal(result.value, 'special-tool-result')
  })

  await t.test('overlapping exempt bindings stay paused until the last one settles', async (t) => {
    const run = await fixture(t)
    const result = await run('return await Promise.all([tools.wait_subagent({}), tools.ask_user_question({})])', {
      wait_subagent: async () => { await delay(500); return 'wait-done' },
      ask_user_question: async () => { await delay(1000); return 'ask-done' },
    })
    assert.equal(result.error, undefined)
    assert.deepEqual(result.value, ['wait-done', 'ask-done'])
  })

  await t.test('the remaining budget expires after an exempt binding settles', async (t) => {
    const run = await fixture(t)
    const result = await run('await tools.wait_subagent({}); while (true) {}', {
      wait_subagent: async () => { await delay(650); return 'waited' },
    })
    assert.equal(result.error?.kind, 'timeout')
    assert.equal(result.error.message, 'execution deadline reached (400ms)' + (run.runtime.retainsState ? '; retained variables were cleared' : ''))
  })

  await t.test('time spent before a wait is deducted from the resumed budget', async (t) => {
    const run = await fixture(t)
    const active = new Set()
    t.after(() => Promise.all(active))
    const result = await run("await tools.hold({ ms: 200 }); await tools.wait_subagent({}); await tools.hold({ ms: 250 }); return 'over-budget'", {
      wait_subagent: async () => { await delay(650); return 'waited' },
      hold: ({ ms }) => {
        const pending = delay(ms).then(() => 'held')
        active.add(pending)
        pending.finally(() => active.delete(pending))
        return pending
      },
    })
    assert.equal(result.error?.kind, 'timeout')
  })

  await t.test('ordinary bindings still consume the program budget', async (t) => {
    const run = await fixture(t)
    const pending = delay(900).then(() => 'late')
    t.after(() => pending)
    const result = await run('return await tools.hold({})', {
      wait_subagent: async () => 'unused',
      hold: () => pending,
    })
    assert.equal(result.error?.kind, 'timeout')
  })

  await t.test('outer cancellation interrupts a worker during an exempt wait', async (t) => {
    const run = await fixture(t)
    const controller = new AbortController()
    const entered = Promise.withResolvers()
    const finish = Promise.withResolvers()
    const pending = run('return await tools.wait_subagent({})', {
      wait_subagent: async () => { entered.resolve(); return await finish.promise },
    }, 400, controller.signal)
    await entered.promise
    controller.abort('user stop')
    try {
      const result = await pending
      assert.equal(result.error?.kind, 'abort')
      assert.equal(result.error.message, run.runtime.retainsState ? 'execution canceled; retained variables were preserved' : 'user stop')
    } finally {
      finish.resolve('released')
    }
  })

  await t.test('parallel programs keep independent deadlines', async (t) => {
    const run = await fixture(t)
    const pending = delay(900).then(() => 'late')
    t.after(() => pending)
    const [waited, ordinary] = await Promise.all([
      run('return await tools.wait_subagent({})', {
        wait_subagent: async () => { await delay(650); return 'waited' },
      }),
      run('return await tools.hold({})', {
        wait_subagent: async () => 'unused',
        hold: () => pending,
      }, 400, undefined, { stateOwner: {} }),
    ])
    assert.equal(waited.value, 'waited')
    assert.equal(ordinary.error?.kind, 'timeout')
  })

  await t.test('a nested runtime invocation keeps its own ordinary-tool deadline', async (t) => {
    const run = await fixture(t)
    const pending = delay(900).then(() => 'late')
    t.after(() => pending)
    const result = await run('return await tools.wait_subagent({})', {
      wait_subagent: () => run('return await tools.hold({})', {
        wait_subagent: async () => 'unused',
        hold: () => pending,
      }, 200, undefined, { stateOwner: {} }),
    })
    assert.equal(result.error, undefined)
    assert.equal(result.value.error.kind, 'timeout')
  })
})
