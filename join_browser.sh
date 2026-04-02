#!/bin/bash
ROOM="${1:-78MSAU}"
BASE="https://web-production-dba7f.up.railway.app"
NAMES=("阿猫" "阿狗" "小明" "小红" "老王" "阿强" "小李")

echo "=== 模拟 7 个玩家加入房间 $ROOM ==="

# Step1: 全部打开页面
for i in "${!NAMES[@]}"; do
  NAME="${NAMES[$i]}"
  SESSION="p$i"
  URL="${BASE}?room=${ROOM}"
  echo "[$((i+1))/7] 打开 $NAME..."
  agent-browser --session "$SESSION" open "$URL" > /dev/null 2>&1 &
  sleep 0.3
done
wait
echo "等待页面加载..."
sleep 3

# Step2: 全部填名字 + 点加入
for i in "${!NAMES[@]}"; do
  NAME="${NAMES[$i]}"
  SESSION="p$i"
  echo ""
  echo "[$((i+1))/7] $NAME 加入..."
  
  # 用 eval 直接操作 DOM，避免 snapshot ref 问题
  agent-browser --session "$SESSION" eval --stdin <<EVALEOF
(function() {
  var input = document.getElementById('entryName');
  if (input) {
    input.value = '${NAME}';
    input.dispatchEvent(new Event('input', {bubbles:true}));
    input.dispatchEvent(new Event('change', {bubbles:true}));
  }
  return input ? '已填入: ' + input.value : '未找到输入框';
})()
EVALEOF
  sleep 0.3
  
  # 点加入按钮（joinRoom 函数）
  agent-browser --session "$SESSION" eval 'typeof joinRoom === "function" ? (joinRoom(), "已点击加入") : "joinRoom未定义"' 2>&1
  sleep 0.5
done

echo ""
echo "等待加入完成..."
sleep 2

# Step3: 检查并准备
for i in "${!NAMES[@]}"; do
  NAME="${NAMES[$i]}"
  SESSION="p$i"
  echo "[$((i+1))/7] $NAME 准备..."
  
  agent-browser --session "$SESSION" eval '(function(){
    var btn = document.getElementById("btnReady");
    if (btn && !btn.disabled) {
      btn.click();
      return "已准备";
    }
    var phase = document.getElementById("pagePlayerWaiting");
    return phase && !phase.classList.contains("hidden") ? "在等待室但按钮不可用" : "不在等待室,当前页:" + (document.querySelector(".card h2") || {}).textContent;
  })()' 2>&1
  sleep 0.3
done

echo ""
echo "=== 完成！法官可以开始游戏了 ==="
echo "注入描述+投票守护..."

# 注入全自动守护：自动描述 + 自动投票
AUTO_GUARD='(function(){
  var words=["这个东西很实用","日常生活必需品","家里常见物品","大家都见过","跟休息相关","每天都接触","比较常见"];
  // 描述守护（纯轮询，不干扰onmessage）
  clearInterval(window._autoDescTimer);
  window._autoDescTimer = setInterval(function(){
    var c=document.getElementById("describeInputCard");
    var t=document.getElementById("describeInput");
    if(c && !c.classList.contains("hidden") && t && t.value.trim()===""){
      t.value=words[Math.floor(Math.random()*words.length)];
      if(typeof submitDescription==="function") submitDescription();
    }
  }, 600);
  // 投票守护：voteWaitCard出现即重置已投标志
  clearInterval(window._autoVoteTimer);
  window._voteSubmitted=false;
  window._autoVoteTimer = setInterval(function(){
    var voteWait=document.getElementById("voteWaitCard");
    if(voteWait && !voteWait.classList.contains("hidden")){ window._voteSubmitted=false; return; }
    var voteCard=document.getElementById("voteCard");
    if(!voteCard || voteCard.classList.contains("hidden")) return;
    if(window._voteSubmitted) return;
    var options=voteCard.querySelectorAll(".vote-option");
    if(!options.length) return;
    window._voteSubmitted=true;
    var target=options[Math.floor(Math.random()*options.length)];
    target.click();
    setTimeout(function(){
      var btns=document.querySelectorAll("#voteCard button");
      for(var b of btns){ if(!b.disabled && b.textContent.includes("确定投票")){b.click();break;} }
    }, 400);
  }, 800);
  // WS断线自动重连
  clearInterval(window._wsWatchTimer);
  window._wsWatchTimer = setInterval(function(){
    if(window.ws && window.ws.readyState===1) return;
    var saved=localStorage.getItem("ug_token");
    var room=localStorage.getItem("ug_roomId");
    if(!saved||!room) return;
    window.ws=new WebSocket("wss://web-production-dba7f.up.railway.app");
    window.ws.onopen=function(){ window.ws.send(JSON.stringify({type:"rejoin",roomId:room,token:saved})); };
    window.ws.onmessage=function(e){ try{ handleMessage(JSON.parse(e.data)); }catch(ex){} };
  }, 5000);
  return "ok";
})()'

for i in "${!NAMES[@]}"; do
  SESSION="p$i"
  agent-browser --session "$SESSION" eval "$AUTO_GUARD" > /dev/null 2>&1 &
done
wait

echo "查看状态: agent-browser --session p0 screenshot"
