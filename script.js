let apiConfig;
let lastRequestTime = 0;
let currentAudioURL = null;
let requestCounter = 0;

const API_CONFIG = {
    'workers-api': {
        url: 'https://worker-tts.api.zwei.de.eu.org/tts'
    },
    'deno-api': {
        url: 'https://deno-tts.api.zwei.de.eu.org/tts'
    }
};

function loadSpeakers() {
    return $.ajax({
        url: 'speakers.json',
        method: 'GET',
        dataType: 'json',
        success: function(data) {
            apiConfig = data;
            updateSpeakerOptions('workers-api');
        },
        error: function(jqXHR, textStatus, errorThrown) {
            console.error(`加载讲述者失败：${textStatus} - ${errorThrown}`);
            showError('加载讲述者失败，请刷新页面重试。');
        }
    });
}

function updateSpeakerOptions(apiName) {
    const speakers = apiConfig[apiName].speakers;
    const speakerSelect = $('#speaker');
    speakerSelect.empty();
    
    Object.entries(speakers).forEach(([key, value]) => {
        speakerSelect.append(new Option(value, key));
    });
}

function updateSliderLabel(sliderId, labelId) {
    const slider = $(`#${sliderId}`);
    const label = $(`#${labelId}`);
    label.text(slider.val());
    
    slider.off('input').on('input', function() {
        label.text(this.value);
    });
}

$(document).ready(function() {
    loadSpeakers().then(() => {
        $('#apiTips').text('使用 Workers API，每天限制 100000 次请求');
        
        // 初始化音频播放器
        initializeAudioPlayer();
        
        $('[data-toggle="tooltip"]').tooltip();

        $('#api').on('change', function() {
            const apiName = $(this).val();
            updateSpeakerOptions(apiName);
            
            $('#rate, #pitch').val(0);
            updateSliderLabel('rate', 'rateValue');
            updateSliderLabel('pitch', 'pitchValue');
            
            const tips = {
                'workers-api': '使用 Workers API，每天限制 100000 次请求',
                'deno-api': '使用 Deno API，基于 Lobe-TTS，暂不支持语速语调调整'
            };
            $('#apiTips').text(tips[apiName] || '');
        });

        updateSliderLabel('rate', 'rateValue');
        updateSliderLabel('pitch', 'pitchValue');

        $('#generateButton').on('click', function() {
            if (canMakeRequest()) {
                generateVoice(false);
            } else {
                showError('请稍候再试，每3秒只能请求一次。');
            }
        });

        $('#previewButton').on('click', function() {
            if (canMakeRequest()) {
                generateVoice(true);
            } else {
                showError('请稍候再试，每3秒只能请求一次。');
            }
        });

        $('#text').on('input', function() {
            const currentLength = $(this).val().length;
            $('#charCount').text(`最多25000个字符，目前已输入${currentLength}个字符`);
        });
    });
});

function canMakeRequest() {
    const currentTime = Date.now();
    if (currentTime - lastRequestTime >= 3000) {
        lastRequestTime = currentTime;
        return true;
    }
    return false;
}

function generateVoice(isPreview) {
    const apiName = $('#api').val();
    const apiUrl = API_CONFIG[apiName].url;
    const text = $('#text').val().trim();
    
    if (!text) {
        showError('请输入要转换的文本');
        return;
    }

    if (isPreview) {
        const previewText = text.substring(0, 20);
        makeRequest(apiUrl, true, previewText, apiName === 'deno-api');
        return;
    }

    // 处理长文本
    const segments = splitText(text);
    if (segments.length > 1) {
        generateVoiceForLongText(segments).then(finalBlob => {
            if (finalBlob) {
                if (currentAudioURL) {
                    URL.revokeObjectURL(currentAudioURL);
                }
                currentAudioURL = URL.createObjectURL(finalBlob);
                $('#result').show();
                $('#audio').attr('src', currentAudioURL);
                $('#download').attr('href', currentAudioURL);

                const timestamp = new Date().toLocaleTimeString();
                const speaker = $('#speaker option:selected').text();
                const shortenedText = text.length > 5 ? text.substring(0, 5) + '...' : text;
                addHistoryItem(timestamp, speaker, shortenedText, finalBlob);
            }
        }).finally(() => {
            $('#generateButton').prop('disabled', false);
            $('#previewButton').prop('disabled', false);
        });
    } else {
        requestCounter++;
        const currentRequestId = requestCounter;
        makeRequest(apiUrl, false, text, apiName === 'deno-api', `#${currentRequestId}`);
    }
}

const cachedAudio = new Map();

function makeRequest(url, isPreview, text, isDenoApi, requestId = '') {
    try {
        new URL(url);
    } catch (e) {
        showError('无效的请求地址');
        return Promise.reject(e);
    }
    
    showLoading('正在生成语音，请稍候...');
    $('#generateButton').prop('disabled', true);
    $('#previewButton').prop('disabled', true);

    if (currentAudioURL) {
        URL.revokeObjectURL(currentAudioURL);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000);

    const requestBody = {
        text: text,
        voice: $('#speaker').val(),
        rate: parseInt($('#rate').val()),
        pitch: parseInt($('#pitch').val()),
        preview: isPreview
    };

    return fetch(url, { 
        method: 'POST',
        signal: controller.signal,
        headers: {
            'Accept': 'audio/mpeg',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
    })
    .then(response => {
        clearTimeout(timeoutId);
        if (!response.ok) {
            throw new Error(`服务器响应错误: ${response.status}`);
        }
        if (!response.headers.get('content-type')?.includes('audio/')) {
            throw new Error('响应类型错误');
        }
        return response.blob();
    })
    .then(blob => {
        if (!blob.type.includes('audio/')) {
            throw new Error('返回的不是音频文件');
        }
        
        currentAudioURL = URL.createObjectURL(blob);
        $('#result').show();
        $('#audio').attr('src', currentAudioURL);
        $('#download')
            .removeClass('disabled')
            .attr('href', currentAudioURL);

        if (!isPreview) {
            const timestamp = new Date().toLocaleTimeString();
            const speaker = $('#speaker option:selected').text();
            const shortenedText = text.length > 7 ? text.substring(0, 7) + '...' : text;
            addHistoryItem(timestamp, speaker, shortenedText, blob, requestId);
        }
    })
    .catch(error => {
        console.error('请求错误:', error);
        if (error.name === 'AbortError') {
            showError('请求超时，请重试');
        } else {
            showError(`生成失败：${isDenoApi ? 'Deno API 服务暂时不可用，请尝试使用 Workers API' : error.message}`);
        }
    })
    .finally(() => {
        hideLoading();
        $('#generateButton').prop('disabled', false);
        $('#previewButton').prop('disabled', false);
    });
}

function showError(message) {
    showMessage(message, 'danger');
}

function addHistoryItem(timestamp, speaker, text, audioBlob, requestInfo = '') {
    const MAX_HISTORY = 50;
    const historyItems = $('#historyItems');
    
    if (historyItems.children().length >= MAX_HISTORY) {
        const oldestItem = historyItems.children().last();
        oldestItem.remove();
    }

    const audioURL = URL.createObjectURL(audioBlob);
    cachedAudio.set(audioURL, audioBlob);
    
    const historyItem = $(`
        <div class="history-item list-group-item" style="opacity: 0;">
            <div class="d-flex justify-content-between align-items-center">
                <span class="text-truncate" style="max-width: 60%;">
                    <strong class="text-primary">${requestInfo}</strong> 
                    ${timestamp} - <span class="text-primary">${speaker}</span> - ${text}
                </span>
                <div class="btn-group">
                    <button class="btn btn-sm btn-outline-primary play-btn" data-url="${audioURL}">
                        <i class="fas fa-play"></i>
                    </button>
                    <button class="btn btn-sm btn-outline-success" onclick="downloadAudio('${audioURL}')">
                        <i class="fas fa-download"></i>
                    </button>
                </div>
            </div>
        </div>
    `);
    
    // 添加整个条目的点击事件
    historyItem.on('click', function(e) {
        // 如果点击的是按钮，不触发条目的点击事件
        if (!$(e.target).closest('.btn-group').length) {
            playAudio(audioURL);
            // 更新预览区
            if (currentAudioURL) {
                URL.revokeObjectURL(currentAudioURL);
            }
            currentAudioURL = URL.createObjectURL(cachedAudio.get(audioURL));
            $('#result').show();
            $('#audio').attr('src', currentAudioURL);
            $('#download')
                .removeClass('disabled')
                .attr('href', currentAudioURL);
        }
    });
    
    // 在条目被移除时清理资源
    historyItem.on('remove', () => {
        URL.revokeObjectURL(audioURL);
        cachedAudio.delete(audioURL);
    });
    
    historyItem.find('.play-btn').on('click', function(e) {
        e.stopPropagation();  // 阻止事件冒泡
        playAudio($(this).data('url'));
    });
    
    $('#historyItems').prepend(historyItem);
    setTimeout(() => historyItem.animate({ opacity: 1 }, 300), 50);
}

function playAudio(audioURL) {
    const audioElement = $('#audio')[0];
    const allPlayButtons = $('.play-btn');
    
    // 如果点击的是当前正在播放的音频
    if (audioElement.src === audioURL && !audioElement.paused) {
        audioElement.pause();
        allPlayButtons.each(function() {
            if ($(this).data('url') === audioURL) {
                $(this).html('<i class="fas fa-play"></i>');
            }
        });
        return;
    }
    
    // 重置所有按钮图标
    allPlayButtons.html('<i class="fas fa-play"></i>');
    
    // 设置新的音频源并播放
    audioElement.src = audioURL;
    audioElement.load();
    
    // 只在实际播放时才设置错误处理
    audioElement.play().then(() => {
        // 更新当前播放按钮图标
        allPlayButtons.each(function() {
            if ($(this).data('url') === audioURL) {
                $(this).html('<i class="fas fa-pause"></i>');
            }
        });
    }).catch(error => {
        if (error.name !== 'AbortError') {  // 忽略中止错误
            console.error('播放失败:', error);
            showError('音频播放失败，请重试');
        }
    });
    
    // 监听播放结束事件
    audioElement.onended = function() {
        allPlayButtons.each(function() {
            if ($(this).data('url') === audioURL) {
                $(this).html('<i class="fas fa-play"></i>');
            }
        });
    };
}

function downloadAudio(audioURL) {
    const blob = cachedAudio.get(audioURL);
    if (blob) {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'audio.mp3';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
    }
}

function clearHistory() {
    $('#historyItems .history-item').each(function() {
        $(this).remove();
    });
    
    // 清理所有缓存的音频
    cachedAudio.forEach((blob, url) => {
        URL.revokeObjectURL(url);
    });
    cachedAudio.clear();
    
    $('#historyItems').empty();
    alert("历史记录已清除！");
}

function initializeAudioPlayer() {
    const audio = document.getElementById('audio');
    audio.style.borderRadius = '12px';
    audio.style.width = '100%';
    audio.style.marginTop = '20px';
    
    // 初始状态设置
    $('#download')
        .addClass('disabled')
        .attr('href', '#');
    $('#audio').attr('src', '');
}

function showMessage(message, type = 'danger') {
    const toast = $(`
        <div class="toast">
            <div class="toast-body toast-${type}">
                ${message}
            </div>
        </div>
    `);
    
    $('.toast-container').append(toast);
    
    // 强制重绘以触发动画
    toast[0].offsetHeight;
    
    // 显示动画
    requestAnimationFrame(() => {
        toast.addClass('show');
    });
    
    // 3秒后淡出并移除
    setTimeout(() => {
        toast.removeClass('show');
        toast.on('transitionend', function() {
            toast.remove();
        });
    }, 3000);
}

// 添加句子结束符号的正则表达式
const SENTENCE_ENDINGS = /[.。！？!?]/;
const PARAGRAPH_ENDINGS = /[\n\r]/;

function splitText(text, maxLength = 2500) {
    const segments = [];
    let remainingText = text.trim();

    // 计算实际字符长度（汉字=2，英文字母和其他字符=1）
    function getTextLength(str) {
        return str.split('').reduce((acc, char) => {
            // 使用 Unicode 范围判断是否为汉字
            return acc + (/[\u4e00-\u9fa5]/.test(char) ? 2 : 1);
        }, 0);
    }

    while (remainingText.length > 0) {
        // 如果剩余文本的实际长度小于最大长度，直接添加
        if (getTextLength(remainingText) <= maxLength * 2) {  // 将最大长度乘2
            segments.push(remainingText);
            break;
        }

        let splitIndex = -1;
        const searchStart = Math.max(maxLength - 300, 0);
        const searchEnd = Math.min(maxLength + 200, remainingText.length);
        
        // 1. 优先寻找段落结束符（包括中英文标点）
        const paragraphMatch = remainingText.slice(searchStart, searchEnd).match(/[！？!?.]\n|\n|。|！|？|!|\?|\./);
        if (paragraphMatch) {
            splitIndex = searchStart + paragraphMatch.index + 1;
        }

        // 2. 如果没找到合适的分割点，在最大长度处寻找句号
        if (splitIndex === -1) {
            const sentenceMatch = remainingText.slice(0, maxLength + 200).match(/[。！？!?.][^。！？!?.]*$/);
            if (sentenceMatch) {
                splitIndex = sentenceMatch.index + 1;
            }
        }

        // 3. 如果还是没找到，在最大长度处寻找逗号
        if (splitIndex === -1) {
            const commaMatch = remainingText.slice(maxLength - 200, maxLength + 200).match(/[,，]/);
            if (commaMatch) {
                splitIndex = maxLength - 200 + commaMatch.index + 1;
            }
        }

        // 4. 如果都没找到，在最大长度处分割，但要避免分割英文单词
        if (splitIndex === -1) {
            let currentLength = 0;
            let i = 0;
            // 累加字符长度直到达到最大长度
            while (i < remainingText.length && currentLength < maxLength * 2) {
                currentLength += /[\u4e00-\u9fa5]/.test(remainingText[i]) ? 2 : 1;
                i++;
            }
            splitIndex = i;

            // 避免分割英文单词
            if (/[a-zA-Z]/.test(remainingText[splitIndex - 1]) && /[a-zA-Z]/.test(remainingText[splitIndex])) {
                const lastSpace = remainingText.slice(0, splitIndex).lastIndexOf(' ');
                if (lastSpace > splitIndex - 100) {
                    splitIndex = lastSpace + 1;
                }
            }
        }

        segments.push(remainingText.substring(0, splitIndex).trim());
        remainingText = remainingText.substring(splitIndex).trim();
    }

    return segments;
}

function showLoading(message) {
    let loadingToast = $('.toast-loading');
    if (loadingToast.length) {
        loadingToast.find('.toast-body').html(`
            <div class="text-center">
                <i class="fas fa-spinner fa-spin"></i>
                <div class="mt-2">${message}</div>
                <div class="progress mt-2">
                    <div class="progress-bar" role="progressbar" style="width: 0%"></div>
                </div>
            </div>
        `);
        return;
    }

    const toast = $(`
        <div class="toast toast-loading">
            <div class="toast-body toast-info">
                <div class="text-center">
                    <i class="fas fa-spinner fa-spin"></i>
                    <div class="mt-2">${message}</div>
                    <div class="progress mt-2">
                        <div class="progress-bar" role="progressbar" style="width: 0%"></div>
                    </div>
                </div>
            </div>
        </div>
    `);
    
    $('.toast-container').append(toast);
    requestAnimationFrame(() => {
        toast.addClass('show');
    });
}

function hideLoading() {
    const loadingToast = $('.toast-loading');
    loadingToast.removeClass('show');
    setTimeout(() => loadingToast.remove(), 300);
}

function updateLoadingProgress(progress, message) {
    const loadingToast = $('.toast-loading');
    if (loadingToast.length) {
        loadingToast.find('.progress-bar').css('width', `${progress}%`);
        loadingToast.find('.mt-2').text(message);
    }
}

async function generateVoiceForLongText(segments) {
    const results = [];
    const apiName = $('#api').val();
    const apiUrl = API_CONFIG[apiName].url;
    const totalSegments = segments.length;
    requestCounter++;
    const currentRequestId = requestCounter;
    
    showLoading(`正在生成第 1/${totalSegments} 段语音...`);

    let hasSuccessfulSegment = false;

    for (let i = 0; i < segments.length; i++) {
        try {
            const progress = ((i + 1) / totalSegments * 100).toFixed(1);
            updateLoadingProgress(progress, `正在生成第 ${i + 1}/${totalSegments} 段语音...`);
            
            await makeRequest(apiUrl, false, segments[i], apiName === 'deno-api', `#${currentRequestId}`)
                .then(blob => {
                    if (blob) {
                        hasSuccessfulSegment = true;
                        results.push(blob);
                        const timestamp = new Date().toLocaleTimeString();
                        const speaker = $('#speaker option:selected').text();
                        const shortenedText = segments[i].length > 7 ? segments[i].substring(0, 7) + '...' : segments[i];
                        const requestInfo = `#${currentRequestId}(${i + 1}/${totalSegments})`;
                        addHistoryItem(timestamp, speaker, shortenedText, blob, requestInfo);
                    }
                });
            
            if (i < segments.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        } catch (error) {
            console.error(`分段 ${i + 1} 生成失败:`, error);
            showError(`第 ${i + 1}/${totalSegments} 段生成失败：${error.message}`);
        }
    }

    hideLoading();

    if (!hasSuccessfulSegment) {
        throw new Error('所有片段生成失败');
    }

    return new Blob(results, { type: 'audio/mpeg' });
}

// 在 body 末尾添加 toast 容器
$('body').append('<div class="toast-container"></div>');

// 可以添加其他类型的消息提示
function showWarning(message) {
    showMessage(message, 'warning');
}

function showInfo(message) {
    showMessage(message, 'info');
}