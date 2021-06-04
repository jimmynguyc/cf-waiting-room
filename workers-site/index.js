import { getAssetFromKV, mapRequestToAsset } from '@cloudflare/kv-asset-handler'
import { uuid } from '@cfworker/uuid';

/**
 * The DEBUG flag will do two things that help during development:
 * 1. we will skip caching on the edge, which makes it easier to
 *    debug.
 * 2. we will return an error message on exception in your Response rather
 *    than the default 404.html page.
 */
const DEBUG = true 
const UID_COOKIE_NAME = "__uid"
const MAX_ACTIVE_USER = 1
const MAX_ACTIVE_USER_SESSION_TIMEOUT = 5 // minutes
const PROTECTED_PATH = "/"

function getCookie(request, name) {
  let result = ""
  const cookieString = request.headers.get("Cookie")
  if (cookieString) {
    const cookies = cookieString.split(";")
    cookies.forEach(cookie => {
      const cookiePair = cookie.split("=", 2)
      const cookieName = cookiePair[0].trim()
      if (cookieName === name) {
        const cookieVal = cookiePair[1]
        result = cookieVal
      }
    })
  }
  return result
}

addEventListener('fetch', event => {
  event.respondWith(handleEvent(event))
})

async function cleanUpQueue() {
  let queue = await WAITROOM.get("queue", {type: "json"})
  if (!queue) {
    queue = []
  } 
  let newqueue = queue.filter(q => ((Date.now() - q.time) < MAX_ACTIVE_USER_SESSION_TIMEOUT * 60 * 1000))
  if (newqueue.length != queue.length) {
    return WAITROOM.put("queue", JSON.stringify(newqueue))
  } else {
    return Promise.resolve()
  }
}

async function removeFromQueue(uid) {
  let queue = await WAITROOM.get("queue", {type: "json"})
  if (!queue) {
    queue = []
  } 
  queue = queue.filter((q) => q.uid == uid)
  return WAITROOM.put("queue", JSON.stringify(queue))
}

function getUidFromCookie(event) {
  try {
    return JSON.parse(getCookie(event.request, UID_COOKIE_NAME))
  } catch(e) {
    return false
  }
}

function handleEvent(event) {
  let options = {}
  if (DEBUG) {
    // customize caching
    options.cacheControl = {
      bypassCache: true,
    }
  }

  try {
    const parsedUrl = new URL(event.request.url)
    let pathname = parsedUrl.pathname

    if (pathname == PROTECTED_PATH) {
      return handleWaitRoom(event, options)
    } else if (pathname == "/queue-stat") {
      return handleQueueStat(event, options) 
    } else if (pathname == "/thankyou") {
      return handleThankYou(event, options);
    } else {
      return handleNormally(event, undefined, options)
    }
  } catch (e) {
    if (DEBUG) {
      // if an error is thrown try to serve the asset at 404.html
      return new Response(e.message || e.toString(), { status: 500 })
    }
  }
}

async function handleQueueStat(event) {
  await cleanUpQueue()
  let queue = await WAITROOM.get("queue", {type: "json"}) 

  return new Response(JSON.stringify(queue), { status: 200 }) 
}

async function handleThankYou(event, options) {
  let uid = getUidFromCookie(event)
  await removeFromQueue(uid)

  try {
    let notFoundResponse = await getAssetFromKV(event, {
      mapRequestToAsset: req => new Request(`${new URL(req.url).origin}/thankyou.html`, req),
      ...options
    })

    return new Response(notFoundResponse.body, { ...notFoundResponse, status: 200 })
  } catch (e) {}
}

async function handleWaitRoom(event, options) {
  await cleanUpQueue()
  let uid = getUidFromCookie(event) || {
    uid: uuid(),
    time: Date.now()
  } 
  
  let queue = await WAITROOM.get("queue", {type: "json"})
  if (!queue) {
    queue = []
  }
  const queuePos = queue.findIndex(item => item.uid == uid.uid)
  if (queuePos < 0) {
    queue.push(uid)
    await WAITROOM.put("queue", JSON.stringify(queue))
  }

  const activeUsersCount = queue.length
  
  if (queuePos >= MAX_ACTIVE_USER && queue.length > MAX_ACTIVE_USER) {
    try {
      const waitRoomResponse = await getAssetFromKV(event, {
        mapRequestToAsset: req => new Request(`${new URL(req.url).origin}/waitroom.html`, req),
        ...options
      })

      const response = new Response(waitRoomResponse.body, { ...waitRoomResponse, status: 200 }) 
      response.headers.set('Set-Cookie', `${UID_COOKIE_NAME}=${JSON.stringify(uid)}`)

      return response
    } catch (e) {
      if (DEBUG) {
        // if an error is thrown try to serve the asset at 404.html
        return new Response(e.message || e.toString(), { status: 500 })
      }
    }
  }
  
  uid.time = Date.now()
  return handleNormally(event, uid);
}

async function handleNormally(event, uid, options) {
  uid = uid || getUidFromCookie(event) || {
    uid: uuid(),
    time: Date.now()
  } 
  /*v*
   * You can add custom logic to how we fetch your assets
   * by configuring the function `mapRequestToAsset`
   */
  // options.mapRequestToAsset = handlePrefix(/^\/docs/)

  try {
    const page = await getAssetFromKV(event, options)
    // allow headers to be altered

    const response = new Response(page.body, page)

    response.headers.set('X-XSS-Protection', '1; mode=block')
    response.headers.set('X-Content-Type-Options', 'nosniff')
    response.headers.set('X-Frame-Options', 'DENY')
    response.headers.set('Referrer-Policy', 'unsafe-url')
    response.headers.set('Feature-Policy', 'none')
    response.headers.set('Set-Cookie', `${UID_COOKIE_NAME}=${JSON.stringify(uid)}`)

    return response

  } catch (e) {
    // if an error is thrown try to serve the asset at 404.html
    if (!DEBUG) {
      try {
        let notFoundResponse = await getAssetFromKV(event, {
          mapRequestToAsset: req => new Request(`${new URL(req.url).origin}/404.html`, req),
        })

        return new Response(notFoundResponse.body, { ...notFoundResponse, status: 404 })
      } catch (e) {}
    }

    return new Response(e.message || e.toString(), { status: 500 })
  }
}

/**
 * Here's one example of how to modify a request to
 * remove a specific prefix, in this case `/docs` from
 * the url. This can be useful if you are deploying to a
 * route on a zone, or if you only want your static content
 * to exist at a specific path.
 */
function handlePrefix(prefix) {
  return request => {
    // compute the default (e.g. / -> index.html)
    let defaultAssetKey = mapRequestToAsset(request)
    let url = new URL(defaultAssetKey.url)

    // strip the prefix from the path for lookup
    url.pathname = url.pathname.replace(prefix, '/')

    // inherit all other props from the default request
    return new Request(url.toString(), defaultAssetKey)
  }
}
