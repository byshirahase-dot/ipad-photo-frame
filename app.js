'use strict';

// ===================== 設定 =====================

var CLIENT_ID = '222393962099-2c1f3gm8phanh3netrf2k1ss3snc75np.apps.googleusercontent.com';
var SCOPE     = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';

var SLIDE_DURATION_MS       = 8000;         // 1枚あたりの表示時間
var URL_REFRESH_INTERVAL_MS = 45 * 60 * 1000; // 45分ごとに写真URL再取得
var POLL_INTERVAL_MS        = 4000;         // 選択完了ポーリング間隔

// ===================== 状態 =====================

var accessToken     = null;
var photos          = [];
var currentIndex    = 0;
var slideshowTimer  = null;
var urlRefreshTimer = null;
var overlayTimer    = null;
var pollTimer       = null;
var isTransitioning = false;
var currentSessionId = null;

// ===================== 認証 (GIS) =====================

var tokenClient = null;

function initGoogleAuth() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: onTokenReceived,
  });
}

function onTokenReceived(response) {
  if (response.error) {
    console.error('Auth error:', response.error);
    clearAuth();
    showScreen('screen-login');
    return;
  }
  var exp = parseInt(response.expires_in || '3600', 10);
  accessToken = response.access_token;
  localStorage.setItem('access_token', response.access_token);
  localStorage.setItem('token_expires_at', String(Date.now() + exp * 1000));
  setTimeout(silentRefresh, Math.max(0, exp - 300) * 1000);

  // 保存済みセッションがあればそれを再利用、なければ新しいセッションを作成
  var sessionId = localStorage.getItem('picker_session_id');
  if (sessionId) {
    resumeSession(sessionId);
  } else {
    startPickerSession();
  }
}

function requestLogin() {
  if (!tokenClient) initGoogleAuth();
  tokenClient.requestAccessToken({ prompt: 'consent' });
}

function silentRefresh() {
  if (!tokenClient) initGoogleAuth();
  tokenClient.requestAccessToken({ prompt: '' });
}

function loadStoredToken() {
  var token = localStorage.getItem('access_token');
  var exp   = parseInt(localStorage.getItem('token_expires_at') || '0', 10);
  if (token && Date.now() < exp - 30000) {
    accessToken = token;
    var remaining = exp - Date.now();
    setTimeout(silentRefresh, Math.max(0, remaining - 300000));
    return true;
  }
  return false;
}

function clearAuth() {
  localStorage.removeItem('access_token');
  localStorage.removeItem('token_expires_at');
  accessToken = null;
}

// ===================== API =====================

function apiFetch(method, url, body, callback) {
  var xhr = new XMLHttpRequest();
  xhr.open(method, url, true);
  xhr.setRequestHeader('Authorization', 'Bearer ' + accessToken);
  if (body) xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.onreadystatechange = function() {
    if (xhr.readyState !== 4) return;
    if (xhr.status === 401) {
      clearAuth();
      showScreen('screen-login');
      return;
    }
    if (xhr.status < 200 || xhr.status >= 300) {
      console.error('API error ' + xhr.status + ':', xhr.responseText);
      callback(new Error('HTTP ' + xhr.status), null);
      return;
    }
    try {
      callback(null, JSON.parse(xhr.responseText));
    } catch(e) {
      callback(e, null);
    }
  };
  xhr.send(body ? JSON.stringify(body) : null);
}

// ===================== Picker API =====================

function startPickerSession() {
  stopSlideshow();
  showScreen('screen-picker');
  document.getElementById('picker-loading').style.display = 'block';
  document.getElementById('picker-link').style.display = 'none';
  document.getElementById('picker-waiting').style.display = 'none';

  apiFetch('POST', 'https://photospicker.googleapis.com/v1/sessions', {}, function(err, data) {
    if (err) {
      document.getElementById('picker-loading').textContent = 'エラー。再ログインしてください。';
      return;
    }
    var sessionId = data.id;
    currentSessionId = sessionId;
    localStorage.setItem('picker_session_id', sessionId);

    document.getElementById('picker-loading').style.display = 'none';
    document.getElementById('picker-link').href = data.pickerUri;
    document.getElementById('picker-link').style.display = 'inline-block';
    document.getElementById('picker-waiting').style.display = 'block';

    startPolling(sessionId);
  });
}

function startPolling(sessionId) {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(function() {
    apiFetch('GET', 'https://photospicker.googleapis.com/v1/sessions/' + sessionId, null, function(err, data) {
      if (err) return;
      if (data.mediaItemsSet) {
        clearInterval(pollTimer);
        pollTimer = null;
        fetchPickedPhotos(sessionId);
      }
    });
  }, POLL_INTERVAL_MS);
}

function resumeSession(sessionId) {
  apiFetch('GET', 'https://photospicker.googleapis.com/v1/sessions/' + sessionId, null, function(err, data) {
    if (err || !data || !data.mediaItemsSet) {
      localStorage.removeItem('picker_session_id');
      startPickerSession();
      return;
    }
    currentSessionId = sessionId;
    fetchPickedPhotos(sessionId);
  });
}

function fetchPickedPhotos(sessionId) {
  var all = [];
  function fetchPage(pageToken) {
    var url = 'https://photospicker.googleapis.com/v1/mediaItems?sessionId=' + sessionId + '&pageSize=100';
    if (pageToken) url += '&pageToken=' + pageToken;
    apiFetch('GET', url, null, function(err, data) {
      if (err) {
        document.getElementById('photo-info').textContent = '読み込みエラー';
        return;
      }
      var items = (data.mediaItems || []).filter(function(item) {
        return item.mediaFile &&
               item.mediaFile.mimeType &&
               item.mediaFile.mimeType.indexOf('image/') === 0;
      });
      all = all.concat(items);
      if (data.nextPageToken) {
        fetchPage(data.nextPageToken);
      } else {
        onPhotosLoaded(all, sessionId);
      }
    });
  }
  fetchPage(null);
}

function onPhotosLoaded(items, sessionId) {
  if (!items.length) {
    localStorage.removeItem('picker_session_id');
    startPickerSession();
    return;
  }
  photos = items;
  shuffle(photos);
  currentIndex = 0;
  showScreen('screen-slideshow');
  showPhoto(currentIndex, true);

  if (slideshowTimer) clearInterval(slideshowTimer);
  slideshowTimer = setInterval(advanceSlide, SLIDE_DURATION_MS);

  // 45分ごとに baseUrl を再取得（URLは約1時間で期限切れ）
  if (urlRefreshTimer) clearInterval(urlRefreshTimer);
  urlRefreshTimer = setInterval(function() {
    fetchPickedPhotos(sessionId);
  }, URL_REFRESH_INTERVAL_MS);
}

function getPhotoUrl(photo) {
  return photo.mediaFile.baseUrl + '=w2048-h1536';
}

// ===================== スライドショー =====================

function shuffle(arr) {
  for (var i = arr.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
}

function updateInfo() {
  document.getElementById('photo-info').textContent =
    (currentIndex + 1) + ' / ' + photos.length;
}

function showPhoto(index, immediate) {
  var img = document.getElementById('photo-display');
  var url = getPhotoUrl(photos[index]);

  if (immediate) {
    img.src = url;
    updateInfo();
    preloadNext(index);
    return;
  }

  isTransitioning = true;
  img.style.opacity = '0';
  setTimeout(function() {
    img.src = url;
    setTimeout(function() {
      img.style.opacity = '1';
      isTransitioning = false;
      updateInfo();
      preloadNext(index);
    }, 50);
  }, 800);
}

function preloadNext(index) {
  if (photos.length < 2) return;
  var nextIdx = (index + 1) % photos.length;
  var img = new Image();
  img.src = getPhotoUrl(photos[nextIdx]);
}

function advanceSlide() {
  if (isTransitioning || photos.length === 0) return;
  currentIndex = (currentIndex + 1) % photos.length;
  showPhoto(currentIndex, false);
}

function stopSlideshow() {
  if (slideshowTimer)  { clearInterval(slideshowTimer);  slideshowTimer  = null; }
  if (urlRefreshTimer) { clearInterval(urlRefreshTimer); urlRefreshTimer = null; }
  if (pollTimer)       { clearInterval(pollTimer);       pollTimer       = null; }
}

// ===================== 時計 =====================

function updateClock() {
  var now = new Date();
  var hh = now.getHours() < 10 ? '0' + now.getHours() : '' + now.getHours();
  var mm = now.getMinutes() < 10 ? '0' + now.getMinutes() : '' + now.getMinutes();
  document.getElementById('clock').textContent = hh + ':' + mm;
}

// ===================== オーバーレイ =====================

function showOverlay() {
  var ov = document.getElementById('overlay');
  ov.classList.add('visible');
  clearTimeout(overlayTimer);
  overlayTimer = setTimeout(function() {
    ov.classList.remove('visible');
  }, 4000);
}

// ===================== 画面切り替え =====================

function showScreen(id) {
  var screens = document.querySelectorAll('.screen');
  for (var i = 0; i < screens.length; i++) {
    screens[i].classList.remove('active');
  }
  document.getElementById(id).classList.add('active');
}

// ===================== 初期化 =====================

document.addEventListener('DOMContentLoaded', function() {
  updateClock();
  setInterval(updateClock, 10000);

  initGoogleAuth();

  document.getElementById('btn-login').addEventListener('click', requestLogin);

  document.getElementById('btn-picker-logout').addEventListener('click', function() {
    stopSlideshow();
    clearAuth();
    localStorage.clear();
    showScreen('screen-login');
  });

  document.getElementById('btn-reselect').addEventListener('click', function() {
    localStorage.removeItem('picker_session_id');
    startPickerSession();
  });

  document.getElementById('btn-logout').addEventListener('click', function() {
    stopSlideshow();
    clearAuth();
    localStorage.clear();
    showScreen('screen-login');
  });

  document.getElementById('screen-slideshow').addEventListener('click', showOverlay);

  // ?logout で強制ログアウト
  if (window.location.search.indexOf('logout') >= 0) {
    stopSlideshow();
    clearAuth();
    localStorage.clear();
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname);
    }
    showScreen('screen-login');
    return;
  }

  // 保存済みトークンがあればそのまま続行
  if (loadStoredToken()) {
    var sessionId = localStorage.getItem('picker_session_id');
    if (sessionId) {
      resumeSession(sessionId);
    } else {
      startPickerSession();
    }
  } else {
    showScreen('screen-login');
  }
});
