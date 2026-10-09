'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  _internals: { createController, DEFAULTS, degToRad, normalizeOptions }
} = require('../index')

test('courseNextPoint advances the active route and follows its new heading', async () => {
  const app = routeApp()
  const controller = createController(app, DEFAULTS)
  await controller.provider.courseCurrentPoint()

  await controller.provider.courseNextPoint()

  assert.deepEqual(app.activations, [
    {
      href: '/resources/routes/test-route',
      reverse: false,
      pointIndex: 1
    }
  ])
  assert.equal(app.course.activeRoute.pointIndex, 1)
  assert.equal(app.course.arrivalCircle, 100)
  assert.equal(controller.getInfo().target, degToRad(90))
  assert.equal(controller.getInfo().engaged, true)
  assert.ok(lastTurnRate(app) > 0)
})

test('courseNextPoint advances in the traversal order of a reversed route', async () => {
  const app = routeApp({ reverse: true, pointIndex: 1 })
  const controller = createController(app, DEFAULTS)
  await controller.provider.courseCurrentPoint()

  await controller.provider.courseNextPoint()

  assert.deepEqual(app.activations, [
    {
      href: '/resources/routes/test-route',
      reverse: true,
      pointIndex: 2
    }
  ])
})

test('courseNextPoint at the final point clears navigation and puts the pilot in standby', async () => {
  const app = routeApp({ pointIndex: 2 })
  const controller = createController(app, DEFAULTS)
  await controller.provider.courseCurrentPoint()

  await controller.provider.courseNextPoint()

  assert.equal(app.course.activeRoute, null)
  assert.equal(app.course.nextPoint, null)
  assert.equal(app.clears, 1)
  assert.equal(app.activations.length, 0)
  assert.equal(controller.getInfo().state, 'standby')
  assert.equal(controller.getInfo().target, null)
  assert.equal(lastTurnRate(app), 0)
})

test('courseNextPoint rejects a single-point destination without an active route', async () => {
  const app = routeApp()
  app.course.activeRoute = null
  const controller = createController(app, DEFAULTS)
  await controller.provider.courseCurrentPoint()

  await assert.rejects(controller.provider.courseNextPoint(), {
    statusCode: 409,
    message: 'No active route to advance'
  })
  assert.equal(app.activations.length, 0)
  assert.equal(app.clears, 0)
})

test('courseNextPoint rejects compass mode without touching navigation', async () => {
  const app = routeApp()
  const controller = createController(app, DEFAULTS)
  await controller.provider.engage()

  await assert.rejects(controller.provider.courseNextPoint(), {
    statusCode: 409,
    message: 'Cannot advance course point outside route mode'
  })
  assert.equal(app.activations.length, 0)
})

test('a rejected course operation reaches the caller and leaves the pilot engaged', async () => {
  const app = routeApp()
  const failure = new Error('Route resource unavailable')
  app.activateRoute = async () => {
    throw failure
  }
  const controller = createController(app, DEFAULTS)
  await controller.provider.courseCurrentPoint()

  await assert.rejects(controller.provider.courseNextPoint(), failure)
  assert.equal(app.course.activeRoute.pointIndex, 0)
  assert.equal(controller.getInfo().state, 'auto')

  app.course.activeRoute.pointIndex = 2
  app.clearDestination = async () => {
    throw failure
  }
  await assert.rejects(controller.provider.courseNextPoint(), failure)
  assert.equal(controller.getInfo().state, 'auto')
})

for (const trigger of ['arrivalCircleEntered', 'perpendicularPassed']) {
  test(`automatic advancement responds to ${trigger} only`, async () => {
    const app = routeApp()
    const controller = createController(app, {
      ...DEFAULTS,
      autoAdvance: true,
      autoAdvanceTrigger: trigger
    })
    await controller.provider.courseCurrentPoint()
    controller.startAutoAdvance()
    assert.deepEqual(app.subscription, {
      context: 'vessels.self',
      subscribe: [
        {
          path: `notifications.navigation.course.${trigger}`,
          policy: 'instant'
        }
      ]
    })

    app.emitArrival(
      trigger === 'arrivalCircleEntered'
        ? 'perpendicularPassed'
        : 'arrivalCircleEntered'
    )
    await settle()
    assert.equal(app.activations.length, 0)

    app.emitArrival(trigger)
    await settle()
    assert.equal(app.course.activeRoute.pointIndex, 1)

    app.emitArrival(trigger, { state: 'alert', status: { acknowledged: true } })
    app.emitArrival(trigger, { state: 'warn' })
    await settle()
    assert.equal(app.activations.length, 1)

    app.emitArrival(trigger, null)
    await settle()
    assert.equal(app.activations.length, 1)

    app.emitArrival(trigger)
    await settle()
    assert.equal(app.course.activeRoute.pointIndex, 2)

    app.emitArrival(trigger, { state: 'normal' })
    app.emitArrival(trigger)
    await settle()
    assert.equal(app.clears, 1)
    assert.equal(controller.getInfo().state, 'standby')
    controller.stop()
  })
}

for (const first of ['arrivalCircleEntered', 'perpendicularPassed']) {
  test(`either advances on ${first} and ignores the second alarm until both clear`, async () => {
    const app = routeApp()
    const controller = createController(app, {
      ...DEFAULTS,
      autoAdvance: true,
      autoAdvanceTrigger: 'either'
    })
    await controller.provider.courseCurrentPoint()
    controller.startAutoAdvance()
    assert.deepEqual(
      app.subscription.subscribe.map((entry) => entry.path),
      [
        'notifications.navigation.course.arrivalCircleEntered',
        'notifications.navigation.course.perpendicularPassed'
      ]
    )
    const second =
      first === 'arrivalCircleEntered'
        ? 'perpendicularPassed'
        : 'arrivalCircleEntered'
    app.emitArrival(first)
    await settle()
    assert.equal(app.course.activeRoute.pointIndex, 1)

    app.emitArrival(second)
    await settle()
    assert.equal(app.activations.length, 1)
    app.emitArrival(first, null)
    app.emitArrival(first)
    await settle()
    assert.equal(app.activations.length, 1)

    app.emitArrival(first, { state: 'normal' })
    app.emitArrival(second, null)
    app.emitArrival(second)
    await settle()
    assert.equal(app.course.activeRoute.pointIndex, 2)

    app.emitArrival(second, null)
    app.emitArrival(first)
    app.emitArrival(second)
    await settle()
    assert.equal(app.clears, 1)
    assert.equal(controller.getInfo().state, 'standby')
    controller.stop()
  })
}

test('either handles two arrival notifications in one delta once', async () => {
  const app = routeApp()
  const controller = createController(app, {
    ...DEFAULTS,
    autoAdvance: true,
    autoAdvanceTrigger: 'either'
  })
  await controller.provider.courseCurrentPoint()
  controller.startAutoAdvance()
  app.onDelta({
    updates: [
      {
        values: [
          {
            path: 'notifications.navigation.course.arrivalCircleEntered',
            value: { state: 'alert' }
          },
          {
            path: 'notifications.navigation.course.perpendicularPassed',
            value: { state: 'alert' }
          }
        ]
      }
    ]
  })
  await settle()
  assert.equal(app.activations.length, 1)
  controller.stop()
})

test('either waits for startup alarms to clear before accepting an arrival', async () => {
  const app = routeApp()
  app.paths['notifications.navigation.course.arrivalCircleEntered'] = {
    value: { state: 'alert' }
  }
  const controller = createController(app, {
    ...DEFAULTS,
    autoAdvance: true,
    autoAdvanceTrigger: 'either'
  })
  await controller.provider.courseCurrentPoint()
  controller.startAutoAdvance()
  app.emitArrival('perpendicularPassed')
  await settle()
  assert.equal(app.activations.length, 0)
  app.emitArrival('arrivalCircleEntered', null)
  app.emitArrival('perpendicularPassed', null)
  app.emitArrival('arrivalCircleEntered')
  await settle()
  assert.equal(app.activations.length, 1)
  controller.stop()
})

test('either does not start a second course operation while the first is pending', async () => {
  const app = routeApp()
  const activate = app.activateRoute.bind(app)
  let release
  app.activateRoute = async (destination) => {
    await new Promise((resolve) => {
      release = resolve
    })
    await activate(destination)
  }
  const controller = createController(app, {
    ...DEFAULTS,
    autoAdvance: true,
    autoAdvanceTrigger: 'either'
  })
  await controller.provider.courseCurrentPoint()
  controller.startAutoAdvance()
  app.emitArrival('arrivalCircleEntered')
  await settle()
  app.emitArrival('arrivalCircleEntered', null)
  app.emitArrival('perpendicularPassed')
  await settle()
  release()
  await settle()
  assert.equal(app.activations.length, 1)
  controller.stop()
})

test('automatic advancement is disabled by default and the schema warns about Freeboard', () => {
  const app = routeApp()
  const controller = createController(app, DEFAULTS)
  controller.startAutoAdvance()
  assert.equal(app.subscription, undefined)
  const schema = require('../index')({}).schema()
  assert.equal(schema.properties.autoAdvance.default, false)
  assert.ok(schema.properties.autoAdvanceTrigger.enum.includes('either'))
  assert.equal(
    normalizeOptions({ autoAdvanceTrigger: 'either' }).autoAdvanceTrigger,
    'either'
  )
  assert.match(schema.properties.autoAdvance.description, /disable .*Freeboard/)
  assert.match(schema.properties.autoAdvance.description, /skip a waypoint/)
  assert.equal(normalizeOptions({ autoAdvance: 'true' }).autoAdvance, false)
  assert.equal(
    normalizeOptions({ autoAdvanceTrigger: 'unknown' }).autoAdvanceTrigger,
    'perpendicularPassed'
  )
})

test('plugin start wires automatic advancement and plugin stop releases it', async () => {
  const app = routeApp()
  app.registerAutopilotProvider = (provider) => {
    app.provider = provider
  }
  const plugin = require('../index')(app)
  plugin.start({ autoAdvance: true })
  try {
    await app.provider.courseCurrentPoint()
    app.emitArrival('perpendicularPassed')
    await settle()
    assert.equal(app.course.activeRoute.pointIndex, 1)
  } finally {
    plugin.stop()
  }
  assert.equal(app.unsubscribed, true)
})

test('automatic advancement ignores arrivals in standby and outside route mode', async () => {
  const app = routeApp()
  const controller = createController(app, { ...DEFAULTS, autoAdvance: true })
  controller.startAutoAdvance()
  app.emitArrival('perpendicularPassed')
  await settle()
  assert.equal(app.activations.length, 0)

  app.emitArrival('perpendicularPassed', null)
  await controller.provider.engage()
  app.emitArrival('perpendicularPassed')
  await settle()
  assert.equal(app.activations.length, 0)
  assert.equal(app.errors.length, 0)
  controller.stop()
})

test('an arrival already active at startup is not replayed', async () => {
  const app = routeApp()
  app.paths['notifications.navigation.course.perpendicularPassed'] = {
    value: { state: 'alert' }
  }
  const controller = createController(app, { ...DEFAULTS, autoAdvance: true })
  await controller.provider.courseCurrentPoint()
  controller.startAutoAdvance()
  app.emitArrival('perpendicularPassed')
  await settle()
  assert.equal(app.activations.length, 0)

  app.emitArrival('perpendicularPassed', null)
  app.emitArrival('perpendicularPassed')
  await settle()
  assert.equal(app.activations.length, 1)
  controller.stop()
})

test('automatic advancement logs a failed course operation and recovers on a new arrival', async () => {
  const app = routeApp()
  const activate = app.activateRoute
  app.activateRoute = async () => {
    throw new Error('Resource unavailable')
  }
  const controller = createController(app, { ...DEFAULTS, autoAdvance: true })
  await controller.provider.courseCurrentPoint()
  controller.startAutoAdvance()
  app.emitArrival('perpendicularPassed')
  await settle()
  assert.equal(app.course.activeRoute.pointIndex, 0)
  assert.match(app.errors[0], /could not advance route: Resource unavailable/)

  app.activateRoute = activate
  app.emitArrival('perpendicularPassed', null)
  app.emitArrival('perpendicularPassed')
  await settle()
  assert.equal(app.activations.length, 1)
  controller.stop()
})

test('stopping releases the arrival subscription and prevents subsequent arrivals', async () => {
  const app = routeApp()
  const controller = createController(app, { ...DEFAULTS, autoAdvance: true })
  await controller.provider.courseCurrentPoint()
  controller.startAutoAdvance()
  controller.stop()
  assert.equal(app.unsubscribed, true)
  app.emitArrival('perpendicularPassed')
  await settle()
  assert.equal(app.activations.length, 0)
  assert.equal(lastTurnRate(app), 0)
})

test('disengaging or stopping while reading the course prevents a pending advance', async () => {
  for (const action of ['disengage', 'stop']) {
    const app = routeApp()
    let release
    app.getCourse = () =>
      new Promise((resolve) => {
        release = resolve
      })
    const controller = createController(app, DEFAULTS)
    await controller.provider.courseCurrentPoint()
    const advance = controller.provider.courseNextPoint()
    if (action === 'stop') controller.stop()
    else await controller.provider.disengage()
    release(app.course)
    await assert.rejects(advance, { statusCode: 409 })
    assert.equal(app.activations.length, 0)
    assert.equal(app.clears, 0)
  }
})

test('a delayed Freeboard advance can skip a point after the plugin has advanced', async () => {
  const app = routeApp()
  const controller = createController(app, { ...DEFAULTS, autoAdvance: true })
  await controller.provider.courseCurrentPoint()
  controller.startAutoAdvance()
  app.emitArrival('perpendicularPassed')
  await settle()
  assert.equal(app.course.activeRoute.pointIndex, 1)

  // Freeboard evaluates courseData().pointIndex + 1 when its countdown expires.
  await app.activateRoute({
    href: app.course.activeRoute.href,
    reverse: app.course.activeRoute.reverse,
    pointIndex: app.course.activeRoute.pointIndex + 1
  })
  assert.equal(app.course.activeRoute.pointIndex, 2)
  controller.stop()
})

function routeApp(route = {}) {
  const paths = {
    'navigation.headingMagnetic.value': degToRad(30),
    'navigation.magneticVariation.value': 0,
    'navigation.course.calcValues.bearingTrackTrue.value': degToRad(30),
    'navigation.course.calcValues.crossTrackError.value': 0
  }
  const app = {
    course: {
      activeRoute: {
        href: '/resources/routes/test-route',
        pointIndex: 0,
        pointTotal: 3,
        reverse: false,
        ...route
      },
      arrivalCircle: 100,
      nextPoint: { position: { latitude: 48, longitude: -4 } }
    },
    paths,
    activations: [],
    messages: [],
    clears: 0,
    errors: [],
    unsubscribed: false,
    subscriptionmanager: {
      subscribe(subscription, unsubscribes, onError, onDelta) {
        app.subscription = subscription
        app.onDelta = onDelta
        unsubscribes.push(() => {
          app.unsubscribed = true
        })
      }
    },
    emitArrival(trigger, value = { state: 'alert' }) {
      this.onDelta?.({
        updates: [
          {
            values: [
              { path: `notifications.navigation.course.${trigger}`, value }
            ]
          }
        ]
      })
    },
    error(message) {
      this.errors.push(message)
    },
    getSelfPath: (path) => paths[path],
    async getCourse() {
      return this.course
    },
    async activateRoute(destination) {
      this.activations.push(destination)
      this.course.activeRoute = { ...this.course.activeRoute, ...destination }
      paths['navigation.course.calcValues.bearingTrackTrue.value'] =
        degToRad(90)
    },
    async clearDestination() {
      this.clears++
      this.course.activeRoute = null
      this.course.nextPoint = null
    },
    handleMessage(source, delta) {
      this.messages.push({ source, delta })
    }
  }
  return app
}

function lastTurnRate(app) {
  return app.messages
    .at(-1)
    .delta.updates[0].values.find((entry) => entry.path === DEFAULTS.outputPath)
    .value
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve))
}
