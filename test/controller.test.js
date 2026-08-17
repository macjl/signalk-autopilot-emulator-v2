'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  _internals: {
    createController,
    calculateOutput,
    degToRad,
    DEFAULTS,
    adjustedTargetForMode,
    readCurrentAngle,
    readRouteTarget
  }
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
      modes: ['compass', 'gps', 'route', 'windApparent', 'windTrue'],
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

test('heading controller does not fall back to GPS course in compass mode', () => {
  const app = fakeApp({
    'navigation.courseOverGroundTrue.value': degToRad(10)
  })
  const output = calculateOutput(app, DEFAULTS, {
    engaged: true,
    mode: 'compass',
    target: degToRad(20)
  })

  assert.deepEqual(output, { turnRate: 0, error: null })
})

test('gps mode uses configured course input', () => {
  const app = fakeApp({
    'navigation.courseOverGroundTrue.value': degToRad(10)
  })
  const output = calculateOutput(app, DEFAULTS, {
    engaged: true,
    mode: 'gps',
    target: degToRad(20)
  })

  assertNear(output.error, degToRad(10))
  assertNear(output.turnRate, degToRad(10) * DEFAULTS.gain)
})

test('switching to compass captures current magnetic heading', async () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': degToRad(123),
    'environment.wind.angleApparent.value': degToRad(35)
  })
  const controller = createController(app, {
    ...DEFAULTS,
    defaultMode: 'windApparent'
  })

  await controller.provider.engage('virtual')
  await controller.provider.setTarget(degToRad(40), 'virtual')
  await controller.provider.setMode('compass', 'virtual')
  const data = await controller.provider.getData('virtual')
  const output = lastOutput(app)

  assert.equal(data.mode, 'compass')
  assertNear(data.target, degToRad(123))
  assertNear(output.error, 0)
  assertNear(output.turnRate, 0)
})

test('switching to apparent wind captures current wind angle', async () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': degToRad(10),
    'environment.wind.angleApparent.value': degToRad(35)
  })
  const controller = createController(app, DEFAULTS)

  await controller.provider.engage('virtual')
  await controller.provider.setTarget(degToRad(90), 'virtual')
  await controller.provider.setMode('windApparent', 'virtual')
  const data = await controller.provider.getData('virtual')
  const output = lastOutput(app)

  assert.equal(data.mode, 'windApparent')
  assertNear(data.target, degToRad(35))
  assertNear(output.error, 0)
  assertNear(output.turnRate, 0)
})

test('switching to true wind captures current wind angle', async () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': degToRad(10),
    'environment.wind.angleTrueWater.value': -degToRad(42)
  })
  const controller = createController(app, DEFAULTS)

  await controller.provider.engage('virtual')
  await controller.provider.setTarget(degToRad(90), 'virtual')
  await controller.provider.setMode('windTrue', 'virtual')
  const data = await controller.provider.getData('virtual')
  const output = lastOutput(app)

  assert.equal(data.mode, 'windTrue')
  assertNear(data.target, -degToRad(42))
  assertNear(output.error, 0)
  assertNear(output.turnRate, 0)
})

test('positive wind target adjustment commands starboard on port tack', async () => {
  const app = fakeApp({
    'environment.wind.angleApparent.value': -degToRad(35)
  })
  const controller = createController(app, {
    ...DEFAULTS,
    defaultMode: 'windApparent'
  })

  await controller.provider.engage('virtual')
  await controller.provider.adjustTarget(degToRad(10), 'virtual')
  const data = await controller.provider.getData('virtual')
  const output = lastOutput(app)

  assertNear(data.target, -degToRad(45))
  assertNear(output.error, -degToRad(10))
  assertNear(output.turnRate, degToRad(10) * DEFAULTS.gain)
})

test('positive wind target adjustment commands starboard on starboard tack', async () => {
  const app = fakeApp({
    'environment.wind.angleApparent.value': degToRad(35)
  })
  const controller = createController(app, {
    ...DEFAULTS,
    defaultMode: 'windApparent'
  })

  await controller.provider.engage('virtual')
  await controller.provider.adjustTarget(degToRad(10), 'virtual')
  const data = await controller.provider.getData('virtual')
  const output = lastOutput(app)

  assertNear(data.target, degToRad(25))
  assertNear(output.error, -degToRad(10))
  assertNear(output.turnRate, degToRad(10) * DEFAULTS.gain)
})

test('compass target adjustment remains numerically positive to starboard', async () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': degToRad(35)
  })
  const controller = createController(app, DEFAULTS)

  await controller.provider.engage('virtual')
  await controller.provider.adjustTarget(degToRad(10), 'virtual')
  const data = await controller.provider.getData('virtual')
  const output = lastOutput(app)

  assertNear(data.target, degToRad(45))
  assertNear(output.error, degToRad(10))
  assertNear(output.turnRate, degToRad(10) * DEFAULTS.gain)
})

test('courseCurrentPoint engages route mode', async () => {
  const app = fakeApp({
    'navigation.course.calcValues.bearingTrackTrue.value': degToRad(90),
    'navigation.headingMagnetic.value': degToRad(80),
    'navigation.magneticVariation.value': degToRad(5)
  })
  const controller = createController(app, DEFAULTS)

  await controller.provider.courseCurrentPoint('virtual')
  const data = await controller.provider.getData('virtual')

  assert.equal(data.state, 'auto')
  assert.equal(data.mode, 'route')
  assertNear(data.target, degToRad(85))
  assert.equal(
    data.options.actions.find((action) => action.id === 'courseNextPoint')
      .available,
    true
  )
})

test('courseCurrentPoint without route data falls back to current heading', async () => {
  const app = fakeApp({
    'environment.wind.angleTrueWater.value': -degToRad(50),
    'navigation.headingMagnetic.value': degToRad(123)
  })
  const controller = createController(app, {
    ...DEFAULTS,
    defaultMode: 'windTrue'
  })

  await controller.provider.engage('virtual')
  assertNear((await controller.provider.getData('virtual')).target, -degToRad(50))

  await controller.provider.courseCurrentPoint('virtual')
  const data = await controller.provider.getData('virtual')

  assert.equal(data.mode, 'route')
  assertNear(data.target, degToRad(123))
})

test('courseNextPoint is unavailable after disengaging route mode', async () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': degToRad(123)
  })
  const controller = createController(app, DEFAULTS)

  await controller.provider.courseCurrentPoint('virtual')
  await controller.provider.disengage('virtual')
  const data = await controller.provider.getData('virtual')

  assert.equal(data.state, 'standby')
  assert.equal(
    data.options.actions.find((action) => action.id === 'courseNextPoint')
      .available,
    false
  )
})

test('route target applies cross-track correction', () => {
  const app = fakeApp({
    'navigation.course.calcValues.bearingTrackTrue.value': degToRad(90),
    'navigation.course.calcValues.crossTrackError.value': 100
  })
  const target = readRouteTarget(app, DEFAULTS)

  assertNear(target, degToRad(90) - Math.atan(1))
})

test('route target converts true track to magnetic with variation', () => {
  const app = fakeApp({
    'navigation.course.calcValues.bearingTrackTrue.value': degToRad(90),
    'navigation.magneticVariation.value': degToRad(5)
  })
  const target = readRouteTarget(app, DEFAULTS)

  assertNear(target, degToRad(85))
})

test('route target uses magnetic fallback as magnetic', () => {
  const app = fakeApp({
    'navigation.course.calcValues.bearingTrackMagnetic.value': degToRad(90),
    'navigation.magneticVariation.value': degToRad(5)
  })
  const target = readRouteTarget(app, DEFAULTS)

  assertNear(target, degToRad(90))
})

test('route mode controls heading toward dynamic route target', () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': degToRad(80),
    'navigation.course.calcValues.bearingTrackTrue.value': degToRad(90),
    'navigation.magneticVariation.value': degToRad(5)
  })
  const output = calculateOutput(app, DEFAULTS, {
    engaged: true,
    mode: 'route',
    target: readRouteTarget(app, DEFAULTS)
  })

  assertNear(output.error, degToRad(5))
  assertNear(output.turnRate, degToRad(5) * DEFAULTS.gain)
})

test('input reader accepts a Signal K path object as well as a value path', () => {
  const app = fakeApp({
    'navigation.headingMagnetic.value': {
      value: degToRad(42)
    }
  })

  assertNear(readCurrentAngle(app, DEFAULTS, 'compass'), degToRad(42))
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

test('wind target adjustment is helm-directional, not signed-angle addition', () => {
  assertNear(
    adjustedTargetForMode(-degToRad(35), degToRad(10), 'windApparent'),
    -degToRad(45)
  )
  assertNear(
    adjustedTargetForMode(degToRad(35), degToRad(10), 'windApparent'),
    degToRad(25)
  )
  assertNear(
    adjustedTargetForMode(degToRad(35), degToRad(10), 'compass'),
    degToRad(45)
  )
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

function lastOutput(app) {
  const message = app.messages.at(-1)
  const values = message.delta.updates[0].values
  return {
    turnRate: values.find((entry) => entry.path === DEFAULTS.outputPath).value,
    error: values.find((entry) => entry.path === DEFAULTS.errorPath).value
  }
}
