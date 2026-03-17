'use strict';

// ===================== 設定 =====================

var CLIENT_ID    = 'amzn1.application-oa2-client.37b5eb1b2c3a4385a6fda690e9fab380';
var REDIRECT_URI = 'https://byshirahase-dot.github.io/ipad-photo-frame/';
var SCOPE        = 'profile clouddrive:read_all';
var API_BASE     = 'https://drive.amazonaws.com/v1';

var SLIDE_DURATION_MS       = 8000;
var URL_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30分ごとにtempLink再取得

// ===================== 状態 =====================

var accessToken     = null;
var photos          = [];
var currentIndex    = 0;
var slideshowTimer  = null;
var urlRefreshTimer = null;
var overlayTimer    = null;
var isTransitioning = false;

// ===================== 認証 =====================

function startLogin() {
  var url = 'https://www.amazon.com/ap/oa'
    + '?client_id='     + encodeURIComponent(CLIENT_ID)
    + '&redirect_uri='  + encodeURIComponent(REDIRECT_URI)
    + '&response_type=token'
    + '&scope='         + encodeURIComponent(SCOPE);
  window.location.href = url;
}

function handleHashParams() {
  var hash = window.location.hash.slice(1);
  if (!hash) return null;

  var params = {};
  hash.split('&').forEach(function(part) {
    var eq = part.indexOf('=');
    if (eq >= 0) params[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1));
  });

  if (window.history && window.history.replaceState) {
    window.history.replaceState(null, '', window.location.pathname);
  } else {
    window.location.hash = '';
  }

  if (params.error) return 'error';

  if (params.access_token) {
    var exp = parseInt(params.expires_in || '3600', 10);
    localStorage.setItem('access_token', params.access_token);
    localStorage.setItem('token_expires_at', String(Date.now() + exp * 1000));
    accessToken = params.access_token;
    // 期限5分前に再ログイン
    setTimeout(function() {
      if (localStorage.getItem('selected_album_id')) {
        localStorage.setItem('resume_album_id', localStorage.getItem('selected_album_id'));
      }
      startLogin();
    }, Math.max(0, exp - 300) * 1000);
    return 'token';
  }
  return null;
}

function loadStoredToken() {
  var token = localStorage.getItem('access_token');
  var exp   = parseInt(localStorage.getItem('token_expires_at') || '0', 10);
  if (token && Date.now() < exp - 30000) {
    accessToken = token;
    var remaining = exp - Date.now();
    setTimeout(function() {
      if (localStorage.getItem('selected_album_id')) {
        localStorage.setItem('resume_album_id', localStorage.getItem('selected_album_id'));
      }
      startLogin();
    }, Math.max(0, remaining - 300000));
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

function apiFetch(url, callback) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', url, true);
  xhr.setRequestHeader('Authorization', 'Bearer ' + accessToken);
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
  xhr.send();
}

// ===================== Amazon Photos API =====================

function fetchAlbums(callback) {
  var url = API_BASE + '/nodes'
    + '?filters=' + encodeURIComponent('kind:ALBUM AND status:AVAILABLE')
    + '&asset=ALL&tempLink=false&limit=200';
  apiFetch(url, function(err, data) {
    if (err) { callback(err, null); return; }
    callback(null, data.data || []);
  });
}

function fetchAllPhotos(albumId, startToken, accumulated, callback) {
  var url = API_BASE + '/nodes/' + albumId + '/children'
    + '?asset=ALL&tempLink=true&limit=200'
    + '&filters=' + encodeURIComponent('status:AVAILABLE');
  if (startToken) url += '&startToken=' + encodeURIComponent(startToken);

  apiFetch(url, function(err, data) {
    if (err) { callback(err, null); return; }

    var items = (data.data || []).filter(function(node) {
      return node.contentProperties &&
             node.contentProperties.contentType &&
             node.contentProperties.contentType.indexOf('image/') === 0;
    });

    var all = accumulated.concat(items);

    if (data.nextToken) {
      fetchAllPhotos(albumId, data.nextToken, all, callback);
    } else {
      callback(null, all);
    }
  });
}

function getPhotoUrl(photo) {
  // tempLink は約30分で期限切れ → 定期的に再取得する
  return photo.tempLink;
}

// ===================== アルバム画面 =====================

function showAlbums() {
  stopSlideshow();
  showScreen('screen-albums');

  var list = document.getElementById('album-list');
  list.innerHTML = '<p class="loading">読み込み中…</p>';

  fetchAlbums(function(err, albums) {
    if (err) {
      list.innerHTML = '<p class="error">読み込みに失敗しました</p>';
      console.error(err);
      return;
    }
    list.innerHTML = '';
    if (!albums.length) {
      list.innerHTML = '<p class="loading">アルバムが見つかりません</p>';
      return;
    }
    albums.forEach(function(album) {
      var btn = document.createElement('button');
      btn.className = 'album-btn';
      btn.textContent = album.name || '無題';
      btn.addEventListener('click', function() {
        startSlideshow(album.id, album.name);
      });
      list.appendChild(btn);
    });
  });
}

// ===================== スライドショー =====================

function startSlideshow(albumId, albumName) {
  localStorage.setItem('selected_album_id', albumId);
  showScreen('screen-slideshow');

  var info = document.getElementById('photo-info');
  info.textContent = '読み込み中…';

  fetchAllPhotos(albumId, null, [], function(err, items) {
    if (err) {
      info.textContent = '読み込みエラー';
      console.error(err);
      return;
    }
    if (!items.length) {
      info.textContent = '写真がありません';
      return;
    }

    photos = items;
    shuffle(photos);
    currentIndex = 0;

    showPhoto(currentIndex, true);

    if (slideshowTimer) clearInterval(slideshowTimer);
    slideshowTimer = setInterval(advanceSlide, SLIDE_DURATION_MS);

    // tempLink は期限切れになるので30分ごとに再取得
    if (urlRefreshTimer) clearInterval(urlRefreshTimer);
    urlRefreshTimer = setInterval(function() {
      fetchAllPhotos(albumId, null, [], function(err2, fresh) {
        if (!err2 && fresh.length) {
          photos = fresh;
          shuffle(photos);
          currentIndex = 0;
        }
      });
    }, URL_REFRESH_INTERVAL_MS);
  });
}

function stopSlideshow() {
  if (slideshowTimer)  { clearInterval(slideshowTimer);  slideshowTimer  = null; }
  if (urlRefreshTimer) { clearInterval(urlRefreshTimer); urlRefreshTimer = null; }
}

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
  var next = new Image();
  next.src = getPhotoUrl(photos[(index + 1) % photos.length]);
}

function advanceSlide() {
  if (isTransitioning || !photos.length) return;
  currentIndex = (currentIndex + 1) % photos.length;
  showPhoto(currentIndex, false);
}

// ===================== 時計 =====================

function updateClock() {
  var now = new Date();
  var hh = now.getHours()   < 10 ? '0' + now.getHours()   : '' + now.getHours();
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

  document.getElementById('btn-login').addEventListener('click', startLogin);

  document.getElementById('btn-back').addEventListener('click', function() {
    localStorage.removeItem('selected_album_id');
    showAlbums();
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

  // OAuth リダイレクト後の処理
  var result = handleHashParams();
  if (result === 'token') {
    var resumeId = localStorage.getItem('resume_album_id');
    localStorage.removeItem('resume_album_id');
    if (resumeId) {
      startSlideshow(resumeId);
    } else {
      showAlbums();
    }
    return;
  }
  if (result === 'error') {
    clearAuth();
    showScreen('screen-login');
    return;
  }

  // 保存済みトークンで継続
  if (loadStoredToken()) {
    var savedId = localStorage.getItem('selected_album_id');
    if (savedId) {
      startSlideshow(savedId);
    } else {
      showAlbums();
    }
  } else {
    showScreen('screen-login');
  }
});
