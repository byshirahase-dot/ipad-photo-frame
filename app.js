'use strict';

// ===================== 設定 =====================

var CLIENT_ID    = '222393962099-2c1f3gm8phanh3netrf2k1ss3snc75np.apps.googleusercontent.com';
var REDIRECT_URI = 'https://byshirahase-dot.github.io/ipad-photo-frame/';
var SCOPE        = 'https://www.googleapis.com/auth/photoslibrary.readonly';

var SLIDE_DURATION_MS      = 8000;        // 1枚あたりの表示時間（ミリ秒）
var URL_REFRESH_INTERVAL_MS = 45 * 60 * 1000; // 45分ごとに写真URLを再取得

// ===================== 状態 =====================

var accessToken     = null;
var photos          = [];
var currentIndex    = 0;
var currentAlbumId  = null;
var slideshowTimer  = null;
var urlRefreshTimer = null;
var overlayTimer    = null;
var isTransitioning = false;

// ===================== 認証 =====================

function startLogin(silent) {
  // スライドショー中ならページ再開用に状態を保存
  if (currentAlbumId) {
    localStorage.setItem('resume_album', currentAlbumId);
    localStorage.setItem('resume_index', String(currentIndex));
  }
  var params = 'client_id=' + encodeURIComponent(CLIENT_ID)
    + '&redirect_uri=' + encodeURIComponent(REDIRECT_URI)
    + '&response_type=token'
    + '&scope=' + encodeURIComponent(SCOPE);
  if (silent) params += '&prompt=none';
  window.location.href = 'https://accounts.google.com/o/oauth2/v2/auth?' + params;
}

// URLハッシュからトークンを取り出す（OAuth リダイレクト後）
function handleHashParams() {
  var hash = window.location.hash.slice(1);
  if (!hash) return null;

  var params = {};
  hash.split('&').forEach(function(part) {
    var eq = part.indexOf('=');
    if (eq >= 0) params[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1));
  });

  // ハッシュをURLから消す（ブラウザ履歴に残さない）
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
    // 期限5分前にサイレント再認証
    setTimeout(function() { startLogin(true); }, Math.max(0, exp - 300) * 1000);
    return 'token';
  }
  return null;
}

// localStorage の既存トークンを読み込む
function loadStoredToken() {
  var token = localStorage.getItem('access_token');
  var exp   = parseInt(localStorage.getItem('token_expires_at') || '0', 10);
  if (token && Date.now() < exp - 30000) {
    accessToken = token;
    var remaining = exp - Date.now();
    setTimeout(function() { startLogin(true); }, Math.max(0, remaining - 300000));
    return true;
  }
  return false;
}

function clearAuth() {
  localStorage.removeItem('access_token');
  localStorage.removeItem('token_expires_at');
  accessToken = null;
}

// ===================== Google Photos API =====================

function apiFetch(url, options, callback) {
  var xhr = new XMLHttpRequest();
  var method = (options && options.method) ? options.method : 'GET';
  xhr.open(method, url, true);
  xhr.setRequestHeader('Authorization', 'Bearer ' + accessToken);
  if (options && options.contentType) {
    xhr.setRequestHeader('Content-Type', options.contentType);
  }
  xhr.onreadystatechange = function() {
    if (xhr.readyState !== 4) return;
    if (xhr.status === 401) {
      clearAuth();
      showScreen('screen-login');
      return;
    }
    if (xhr.status < 200 || xhr.status >= 300) {
      callback(new Error('HTTP ' + xhr.status), null);
      return;
    }
    try {
      callback(null, JSON.parse(xhr.responseText));
    } catch(e) {
      callback(e, null);
    }
  };
  xhr.send(options && options.body ? options.body : null);
}

function fetchAlbums(callback) {
  apiFetch('https://photoslibrary.googleapis.com/v1/albums?pageSize=50', null, function(err, data) {
    if (err) { callback(err, null); return; }
    callback(null, data.albums || []);
  });
}

// アルバム内の全写真を再帰的に取得
function fetchAllPhotos(albumId, pageToken, accumulated, callback) {
  var body = { albumId: albumId, pageSize: 100 };
  if (pageToken) body.pageToken = pageToken;

  apiFetch(
    'https://photoslibrary.googleapis.com/v1/mediaItems:search',
    { method: 'POST', contentType: 'application/json', body: JSON.stringify(body) },
    function(err, data) {
      if (err) { callback(err, null); return; }
      var items = (data.mediaItems || []).filter(function(item) {
        return item.mimeType && item.mimeType.indexOf('image/') === 0;
      });
      var all = accumulated.concat(items);
      if (data.nextPageToken) {
        fetchAllPhotos(albumId, data.nextPageToken, all, callback);
      } else {
        callback(null, all);
      }
    }
  );
}

function getPhotoUrl(photo) {
  // iPad Air (2048x1536) に合わせたサイズ
  return photo.baseUrl + '=w2048-h1536';
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

  // フェードアウト後に次の写真をセット
  setTimeout(function() {
    img.src = url;
    // 1フレーム待ってからフェードイン（ブラウザの描画タイミング合わせ）
    setTimeout(function() {
      img.style.opacity = '1';
      isTransitioning = false;
      updateInfo();
      preloadNext(index);
    }, 50);
  }, 800);
}

function preloadNext(index) {
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
  currentAlbumId = null;
}

function startSlideshow(albumId) {
  currentAlbumId = albumId;
  localStorage.setItem('selected_album', albumId);
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

    // トークン更新後の再開：保存済みインデックスを使う
    var savedIdx = parseInt(localStorage.getItem('resume_index') || '-1', 10);
    currentIndex = (savedIdx >= 0 && savedIdx < photos.length) ? savedIdx : 0;
    localStorage.removeItem('resume_index');

    showPhoto(currentIndex, true);

    if (slideshowTimer) clearInterval(slideshowTimer);
    slideshowTimer = setInterval(advanceSlide, SLIDE_DURATION_MS);

    // 45分ごとに baseUrl を更新（Google Photos の URL は約1時間で期限切れ）
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

// ===================== アルバム選択 =====================

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
      var count = album.mediaItemsCount ? ' (' + album.mediaItemsCount + '枚)' : '';
      btn.textContent = (album.title || '無題') + count;
      btn.addEventListener('click', function() {
        startSlideshow(album.id);
      });
      list.appendChild(btn);
    });
  });
}

// ===================== 時計 =====================

function updateClock() {
  var now = new Date();
  var hh = String(now.getHours()).padStart('2', '0');   // iOS9非対応の場合は下の行に差し替え
  var mm = String(now.getMinutes()).padStart('2', '0');
  // padStart が動かない場合のフォールバック
  if (hh.length < 2) hh = '0' + hh;
  if (mm.length < 2) mm = '0' + mm;
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
  // 時計を起動
  updateClock();
  setInterval(updateClock, 10000);

  // ボタン
  document.getElementById('btn-login').addEventListener('click', function() {
    startLogin(false);
  });
  document.getElementById('btn-back').addEventListener('click', function() {
    localStorage.removeItem('selected_album');
    showAlbums();
  });
  document.getElementById('btn-logout').addEventListener('click', function() {
    stopSlideshow();
    clearAuth();
    localStorage.clear();
    showScreen('screen-login');
  });
  document.getElementById('screen-slideshow').addEventListener('click', showOverlay);

  // ?logout でアクセスされたら強制ログアウト
  if (window.location.search.indexOf('logout') >= 0) {
    stopSlideshow();
    clearAuth();
    localStorage.clear();
    window.history.replaceState(null, '', window.location.pathname);
    showScreen('screen-login');
    return;
  }

  // 認証フロー判定
  var result = handleHashParams();

  if (result === 'token') {
    // OAuth リダイレクトから戻ってきた
    var albumId = localStorage.getItem('resume_album') || localStorage.getItem('selected_album');
    localStorage.removeItem('resume_album');
    if (albumId) {
      startSlideshow(albumId);
    } else {
      showAlbums();
    }
  } else if (result === 'error') {
    // サイレント認証失敗 → ログイン画面
    clearAuth();
    showScreen('screen-login');
  } else if (loadStoredToken()) {
    // 保存済みトークンが有効
    var savedAlbum = localStorage.getItem('selected_album');
    if (savedAlbum) {
      startSlideshow(savedAlbum);
    } else {
      showAlbums();
    }
  } else {
    showScreen('screen-login');
  }
});
