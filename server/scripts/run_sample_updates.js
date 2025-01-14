
'use strict'

const _ = require('lodash')
const request = require('request-promise-native')
const protos = require('../blockchain/protos')
const {
  awaitServerPubkey,
  getTxnCreator,
  submitTxns,
  encodeTimestampedPayload
} = require('../system/submit_utils')

const SERVER = process.env.SERVER || 'http://localhost:3000'
const DATA = process.env.DATA
if (DATA.indexOf('.json') === -1) {
  throw new Error('Use the "DATA" environment variable to specify a JSON file')
}

const VARIANCE_FACTOR = 0.75

const RATE = process.env.RATE ? Number(process.env.RATE) : 6

const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : 25

const updateGroups = require(`./${DATA}`)
let createTxn = null

const createUpdate = (privateKey, recordId, property) => {
  return createTxn(privateKey, encodeTimestampedPayload({
    action: protos.SCPayload.Action.UPDATE_PROPERTIES,
    updateProperties: protos.UpdatePropertiesAction.create({
      recordId,
      properties: [protos.PropertyValue.create(property)]
    })
  }))
}

const getVariance = max => {
  if (typeof max === 'object') return _.mapValues(max, getVariance)
  const variance = max * VARIANCE_FACTOR * Math.pow(Math.random(), 2)
  return Math.random() < 0.5 ? -variance : variance
}

const updateValue = (update, oldValue) => {
  if (typeof update.value === 'object') {
    return _.mapValues(update.value, (value, key) => {
      return updateValue(_.assign({}, update, { value }), oldValue[key])
    })
  }

  let value = getVariance(update.value)
  if (update.isAlwaysPositive) value = Math.abs(value)
  if (update.isAverage) value = update.value + value
  if (update.isRelative) value = oldValue + value
  return value
}

const updateProperty = (update, oldValue) => {
  oldValue = oldValue || update.startValue || null
  const { INT, FLOAT, LOCATION } = protos.PropertySchema.DataType
  const property = _.pick(update, 'name', 'dataType')

  if (property.dataType === INT) {
    property.intValue = parseInt(updateValue(update, oldValue || 0))

  } else if (property.dataType === FLOAT) {
    property.floatValue = updateValue(update, oldValue || 0)

  } else if (property.dataType === LOCATION) {
    const defaultLoc = { latitude: 0, longitude: 0 }
    const newLoc = updateValue(update, oldValue || defaultLoc)
    const intLoc = _.mapValues(newLoc, parseInt)

    if (intLoc.latitude > 90000000) intLoc.latitude = -90000000
    else if (intLoc.latitude < -90000000) intLoc.latitude = 90000000
    if (intLoc.longitude > 180000000) intLoc.longitude = -180000000
    else if (intLoc.longitude < -180000000) intLoc.longitude = 180000000

    property.locationValue = protos.Location.create(intLoc)

  } else if (property.name === 'tilt') {
    oldValue = JSON.parse(oldValue)

    const defaultTilt = { x: 0, y: 0 }
    const newTilt = updateValue(update, oldValue || defaultTilt)
    const intTilt = _.mapValues(newTilt, parseInt)

    property.stringValue = JSON.stringify(intTilt)

  } else if (property.name === 'shock') {
    oldValue = JSON.parse(oldValue)

    const defaultShock = { accel: 0, duration: 0 }
    const newShock = updateValue(update, oldValue || defaultShock)
    const intShock = _.mapValues(newShock, parseInt)

    property.stringValue = JSON.stringify(intShock)

  } else {
    throw new Error(`Bad update in JSON: ${property.name}`)
  }

  return property
}

const makeUpdateSubmitter = (count = 0) => () => {
  if (count >= LIMIT) return
  console.log(`Starting update set ${count + 1} of ${LIMIT}`)
  return request(`${SERVER}/records`)
    .then(res => {
      return JSON.parse(res).reduce((oldValues, record) => {
        return _.assign({
          [record.recordId]: _.zipObject(
            _.map(record.properties, prop => prop.name),
            _.map(record.properties, prop => prop.value))
        }, oldValues)
      }, {})
    })

    .then(oldValues => {
      console.log(`Building updates . . .`)
      return updateGroups.reduce((updateTxns, group) => {
        group.updates.forEach(update => {
          if (update.noOpChance && Math.random() < update.noOpChance) return
          const oldValue = oldValues[group.recordId][update.name]
          const prop = updateProperty(update, oldValue)
          updateTxns.push(createUpdate(group.privateKey, group.recordId, prop))
        })
        return updateTxns
      }, [])
    })

    .then(updateTxns => {
      console.log(`Submitting ${updateTxns.length} update transactions . . .`)
      submitTxns(updateTxns)
    })

    .then(() => {
      console.log('Updates committed.')
      const wait = RATE ? 60000 / RATE : 0
      setTimeout(makeUpdateSubmitter(count + 1), wait)
    })
}

protos.compile()
  .then(awaitServerPubkey)
  .then(batcherPublicKey => {
    const txnCreators = {}

    createTxn = (privateKey, payload) => {
      if (!txnCreators[privateKey]) {
        txnCreators[privateKey] = getTxnCreator(privateKey, batcherPublicKey)
      }
      return txnCreators[privateKey](payload)
    }
  })
  .then(() => makeUpdateSubmitter()())
  .catch(err => {
    console.error(err.toString())
    process.exit()
  })
