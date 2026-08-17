'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  _internals: { createController, calculateOutput, degToRad, DEFAULTS }
} = require('../index')

test('starts in standby with clean v2 options', async () => {
  const app = fakeApp()
  const controller = createController(app, DEFAULTS)

  assert.deepEqual(await controller.provider.getData('virtual'), {
    options: {
      states: [
        { name: 'standby', engaged: false },
        { name: 'auto', engaged: true }
      ],
      modes: ['compass', 'route', 'windApparent', 'windTrue'],
      actions: [
        { id: 'dodge', name: 'Dodge', available: false },
        { id: 'tack', name: 'Tack', available: false },
        { id: 'gybe', name: 'Gybe', available: false },
        {
          id: 'courseCurrentPoint',
          name: 'Steer to current course point',
          available: true
        },
        {
          id: 'courseNextPoint',
          name: 'Advance to next course point',
          available: false
        }
      ]
    },
    state: 'standby',
    mode: null,
    engaged: false,
    target: null
  })
})

test('engage initializes compass target from current heading', async () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': degToRad(123)
  })
  const controller = createController(app, DEFAULTS)

  await controller.provider.engage('virtual')
  const data = await controller.provider.getData('virtual')

  assert.equal(data.state, 'auto')
  assert.equal(data.mode, 'compass')
  assert.equal(data.engaged, true)
  assert.equal(data.target, degToRad(123))
})

test('heading controller commands starboard turn for positive heading error', () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': degToRad(10)
  })
  const output = calculateOutput(app, DEFAULTS, {
    engaged: true,
    mode: 'compass',
    target: degToRad(20)
  })

  assertNear(output.error, degToRad(10))
  assertNear(output.turnRate, degToRad(10) * DEFAULTS.gain)
})

test('heading controller saturates turn-rate output', () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': degToRad(0)
  })
  const output = calculateOutput(app, DEFAULTS, {
    engaged: true,
    mode: 'compass',
    target: degToRad(180)
  })

  assert.equal(output.turnRate, DEFAULTS.maxTurnRate)
})

test('wind controller uses opposite sign because wind angle is relative to bow', () => {
  const app = fakeApp({
    'environment.wind.angleApparent.value': degToRad(30)
  })
  const output = calculateOutput(app, DEFAULTS, {
    engaged: true,
    mode: 'windApparent',
    target: degToRad(40)
  })

  assertNear(output.error, degToRad(10))
  assertNear(output.turnRate, -degToRad(10) * DEFAULTS.gain)
})

test('standby publishes zero output', () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': degToRad(0)
  })
  const output = calculateOutput(app, DEFAULTS, {
    engaged: false,
    mode: null,
    target: degToRad(90)
  })

  assert.deepEqual(output, { turnRate: 0, error: null })
})

test('tack sets wind target side', async () => {
  const app = fakeApp({
    'environment.wind.angleApparent.value': degToRad(35)
  })
  const controller = createController(app, {
    ...DEFAULTS,
    defaultMode: 'windApparent'
  })

  await controller.provider.engage('virtual')
  await controller.provider.tack('port', 'virtual')
  assertNear((await controller.provider.getData('virtual')).target, -degToRad(35))

  await controller.provider.tack('starboard', 'virtual')
  assertNear((await controller.provider.getData('virtual')).target, degToRad(35))
})

function fakeApp(paths = {}) {
  return {
    getSelfPath(path) {
      return paths[path]
    },
    autopilotUpdate(deviceId, data) {
      this.autopilotUpdates.push({ deviceId, data })
    },
    handleMessage(source, delta) {
      this.messages.push({ source, delta })
    },
    autopilotUpdates: [],
    messages: []
  }
}

function assertNear(actual, expected, epsilon = 1e-12) {
  assert.equal(Math.abs(actual - expected) < epsilon, true)
}
