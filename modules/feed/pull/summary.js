var pull = require('pull-stream')
var pullPushable = require('pull-pushable')
var pullNext = require('pull-next')
var SortedArray = require('sorted-array-functions')
var nest = require('depnest')

exports.gives = nest({
  'feed.pull': [ 'summary' ]
})

exports.create = function () {
  return nest({
    'feed.pull': { summary }
  })
}

function summary (source, opts, cb) {
  var bumpFilter = opts && opts.bumpFilter
  var windowSize = opts && opts.windowSize || 1000
  var last = null
  var returned = false
  var done = false
  return pullNext(() => {
    if (!done) {
      var next = {reverse: true, limit: windowSize, live: false}
      if (last) {
        next.lt = last.timestamp || last.value.sequence
      }
      var pushable = pullPushable()
      pull(
        source(next),
        pull.collect((err, values) => {
          if (err) throw err
          if (!values.length) {
            done = true
            pushable.end()
            if (!returned) cb && cb()
            returned = true
          } else {
            var fromTime = last && last.timestamp || Date.now()
            last = values[values.length - 1]
            groupMessages(values, fromTime, bumpFilter, (err, result) => {
              if (err) throw err
              result.forEach(v => pushable.push(v))
              pushable.end()
              if (!returned) cb && cb()
              returned = true
            })
          }
        })
      )
    }
    return pushable
  })
}

function groupMessages (messages, fromTime, bumpFilter, cb) {
  var follows = {}
  var messageUpdates = {}
  reverseForEach(messages, function (msg) {
    if (!msg.value) return
    var c = msg.value.content
    if (c.type === 'contact') {
      updateContact(msg, follows)
    } else if (c.type === 'vote') {
      if (c.vote && c.vote.link) {
        // only show digs of posts added in the current window
        // and only for the main post
        const group = messageUpdates[c.vote.link]
        if (group) {
          if (c.vote.value > 0) {
            group.lastUpdateType = 'dig'
            group.digs.add(msg.value.author)
            // only bump when filter passes
            if (!bumpFilter || bumpFilter(msg, group)) {
              group.updated = msg.timestamp
            }
          } else {
            group.digs.delete(msg.value.author)
            if (group.lastUpdateType === 'dig' && !group.digs.size && !group.replies.length) {
              group.lastUpdateType = 'reply'
            }
          }
        }
      }
    } else {
      if (c.root || (c.type === 'git-update' && c.repo)) {
        const group = ensureMessage(c.root || c.repo, messageUpdates)
        group.fromTime = fromTime
        group.lastUpdateType = 'reply'
        group.repliesFrom.add(msg.value.author)
        SortedArray.add(group.replies, msg, compareUserTimestamp)
        //group.replies.push(msg)
        group.channel = group.channel || msg.value.content.channel

        // only bump when filter passes
        if (!bumpFilter || bumpFilter(msg, group)) {
          group.updated = msg.timestamp || msg.value.sequence
        }
      } else {
        const group = ensureMessage(msg.key, messageUpdates)
        group.fromTime = fromTime
        group.lastUpdateType = 'post'
        group.updated = msg.timestamp || msg.value.sequence
        group.author = msg.value.author
        group.channel = msg.value.content.channel
        group.message = msg
        group.boxed = typeof msg.value.content === 'string'
      }
    }
  }, () => {
    var result = []
    Object.keys(follows).forEach((key) => {
      if (follows[key].updated) {
        SortedArray.add(result, follows[key], compareUpdated)
      }
    })
    Object.keys(messageUpdates).forEach((key) => {
      if (messageUpdates[key].updated) {
        SortedArray.add(result, messageUpdates[key], compareUpdated)
      }
    })
    cb(null, result)
  })
}

function compareUpdated (a, b) {
  return b.updated - a.updated
}

function reverseForEach (items, fn, cb) {
  var i = items.length - 1
  nextBatch()

  function nextBatch () {
    var start = Date.now()
    while (i >= 0) {
      fn(items[i], i)
      i -= 1
      if (Date.now() - start > 10) break
    }

    if (i > 0) {
      setImmediate(nextBatch)
    } else {
      cb && cb()
    }
  }
}

function updateContact (msg, groups) {
  var c = msg.value.content
  var id = msg.value.author
  var group = groups[id]
  if (c.contact) {
    if (c.following) {
      if (!group) {
        group = groups[id] = {
          type: 'follow',
          lastUpdateType: null,
          contacts: new Set(),
          updated: 0,
          author: id,
          id: id
        }
      }
      group.contacts.add(c.contact)
      group.updated = msg.timestamp || msg.value.sequence
    } else {
      if (group) {
        group.contacts.delete(c.contact)
        if (!group.contacts.size) {
          delete groups[id]
        }
      }
    }
  }
}

function ensureMessage (id, groups) {
  var group = groups[id]
  if (!group) {
    group = groups[id] = {
      type: 'message',
      repliesFrom: new Set(),
      replies: [],
      message: null,
      messageId: id,
      digs: new Set(),
      updated: 0
    }
  }
  return group
}

function compareUserTimestamp (a, b) {
  var isClose = !a.timestamp || !b.timestamp || Math.abs(a.timestamp - b.timestamp) < (10 * 60e3)
  if (isClose) {
    // recieved close together, use provided timestamps
    return a.value.timestamp - b.value.timestamp
  } else {
    return a.timestamp - b.timestamp
  }
}
