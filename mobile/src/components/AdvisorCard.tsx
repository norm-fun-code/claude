import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  ActivityIndicator,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
  useColorScheme,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { getColors, spacing, radius, shadow } from '../theme';
import { SectionHeader } from './SectionHeader';

// Your live financial-planner advisor, embedded. It runs the full projection
// model and stays in sync with your scenarios — nothing to duplicate here.
const ADVISOR_URL = 'https://claude-production-7130.up.railway.app/';

// Open straight into the AI Advisor tab, hide the desktop chrome, and reflow the
// advisor into a full-height mobile chat: messages scroll, input pinned at the
// bottom. We try several ways to reach the advisor view because the planner page
// may expose it as a setTab() call, a clickable tab, or a hash route — whichever
// works, we land on the chat instead of the chart.
const FOCUS_ADVISOR = `
(function(){
  try{
    // Real advisor classes (from renderAdvisorTab): .adv-wrap is a 2-col grid at
    // height calc(100vh-220px) with a 240px conversation rail. On mobile we want
    // a single full-height column with the conversation list reflowed into a
    // compact horizontal strip on top, then the chat filling the rest.
    var css='html,body{height:100%!important;margin:0!important;overflow:hidden!important}'
      +'#chartArea{height:100%!important;display:flex!important;flex-direction:column!important;margin:0!important;padding:0!important}'
      +'.adv-toolbar{flex-wrap:wrap;flex:0 0 auto}'
      +'.adv-wrap{flex:1 1 auto!important;height:auto!important;min-height:0!important;border:none!important;border-radius:0!important;display:flex!important;flex-direction:column!important}'
      // Conversation rail → horizontal scrolling strip at the top.
      +'.adv-rail{flex:0 0 auto!important;display:flex!important;flex-direction:row!important;align-items:stretch!important;border-right:none!important;border-bottom:1px solid var(--bd)!important;overflow-x:auto!important;overflow-y:hidden!important;max-height:54px!important}'
      +'.adv-rail-hdr{flex:0 0 auto!important;border-bottom:none!important;border-right:1px solid var(--bd)!important;padding:6px 10px!important;flex-direction:column!important;justify-content:center!important;gap:3px!important}'
      +'.adv-rail-hdr h4{display:none!important}'
      +'.adv-rail-new{padding:6px 12px!important;white-space:nowrap!important}'
      +'.adv-rail-list{flex:1 1 auto!important;display:flex!important;flex-direction:row!important;gap:6px!important;overflow-x:auto!important;overflow-y:hidden!important;padding:6px!important}'
      +'.adv-rail-item{flex:0 0 auto!important;margin-bottom:0!important;white-space:nowrap!important;max-width:170px!important;display:flex!important;flex-direction:column!important;justify-content:center!important}'
      +'.adv-rail-title{white-space:nowrap!important;padding-right:0!important}'
      +'.adv-rail-meta{display:none!important}'
      +'.adv-rail-actions{display:none!important}'
      +'.adv-rail-footer{display:none!important}'
      // Chat column fills the rest.
      +'.adv-main{flex:1 1 auto!important;min-height:0!important;display:flex!important;flex-direction:column!important;overflow:hidden!important}'
      +'.adv-msgs{flex:1 1 auto!important;min-height:0!important;overflow-y:auto!important;-webkit-overflow-scrolling:touch}'
      +'.adv-input-area{flex:0 0 auto!important;padding-bottom:calc(env(safe-area-inset-bottom,8px) + 10px)!important}';
    var s=document.getElementById('normos-adv-css');
    if(!s){ s=document.createElement('style'); s.id='normos-adv-css'; document.head.appendChild(s); }
    s.innerHTML=css;

    // Switch to the AI Advisor tab. renderAdvisorTab() injects the chat into
    // #chartArea when the tab labeled "AI Advisor" is clicked, so we (a) detect
    // success by the advisor content actually being present, and (b) click the
    // tab by its EXACT label — never a loose "ai" match (that hits Email/Retail).
    function norm(t){ return (t||'').replace(/\\s+/g,' ').trim().toLowerCase(); }
    function advisorVisible(){
      var area=document.getElementById('chartArea');
      var txt=area?area.textContent||'':'';
      // Markers unique to the advisor view.
      return /ask me anything about your plan|ask anything about your plan|ask your own/i.test(txt)
        || !!document.querySelector('.adv-wrap,.adv-msgs,.adv-main,.adv-input-area');
    }
    function tryReachAdvisor(){
      if(advisorVisible()) return true;
      // 1) Global tab function if the page exposes one.
      if(typeof setTab==='function'){ try{setTab('advisor');}catch(e){} if(advisorVisible()) return true; }
      // 2) Click the tab whose label is exactly "AI Advisor" (or its data-tab).
      var nodes=document.querySelectorAll('[data-tab],button,[role="tab"],a,.tab,div');
      for(var i=0;i<nodes.length;i++){
        var el=nodes[i];
        var dt=norm(el.getAttribute&&el.getAttribute('data-tab'));
        var label=norm(el.textContent);
        if(dt==='advisor' || label==='ai advisor' || label==='🤖 ai advisor'){
          try{el.click();}catch(e){}
          if(advisorVisible()) return true;
        }
      }
      return advisorVisible();
    }

    // Hide all the planner chrome WITHOUT needing its class names: walk up from
    // #chartArea to <body> and hide every sibling at each level, then pin
    // #chartArea to fill the screen. This robustly leaves only the chat visible
    // no matter how the surrounding layout is structured.
    function isolateChat(){
      var area=document.getElementById('chartArea');
      if(!area) return;
      var el=area;
      while(el && el.parentElement && el.tagName!=='BODY'){
        var sibs=el.parentElement.children;
        for(var i=0;i<sibs.length;i++){
          if(sibs[i]!==el && sibs[i].id!=='normos-adv-css'){
            sibs[i].style.setProperty('display','none','important');
          }
        }
        // Let the ancestor chain take full height so the chat can fill it.
        el.parentElement.style.setProperty('height','100%','important');
        el.parentElement.style.setProperty('margin','0','important');
        el.parentElement.style.setProperty('padding','0','important');
        el=el.parentElement;
      }
      area.style.setProperty('position','fixed','important');
      area.style.setProperty('top','0','important');
      area.style.setProperty('left','0','important');
      area.style.setProperty('right','0','important');
      area.style.setProperty('bottom','0','important');
      area.style.setProperty('height','100%','important');
      area.style.setProperty('margin','0','important');
      area.style.setProperty('z-index','9999','important');
      area.style.setProperty('background','#fff','important');
      area.style.setProperty('overflow','hidden','important');
      area.style.setProperty('display','flex','important');
      area.style.setProperty('flex-direction','column','important');
    }

    var n=0, iv=setInterval(function(){
      n++;
      // Re-apply the chrome-hiding CSS each tick — the advisor view renders late,
      // so styles injected before it exists must be reasserted.
      var s2=document.getElementById('normos-adv-css'); if(s2) s2.innerHTML=css;
      var reached=tryReachAdvisor();
      if(reached) isolateChat(); // only collapse the chrome once we're on the chat
      if(reached || n>60) clearInterval(iv);
    },150);
  }catch(e){}
  true;
})();
`;

export function AdvisorCard() {
  const isDark = useColorScheme() === 'dark';
  const c = getColors(isDark);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const webRef = useRef<WebView>(null);

  return (
    <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }, shadow(isDark)]}>
      <SectionHeader emoji="🧮" title="Financial Advisor" preserveCase />
      <Text style={[styles.blurb, { color: c.subtext }]}>
        Personalized Q&A grounded in your live financial plan, scenarios, and projections.
      </Text>
      <TouchableOpacity
        onPress={() => {
          setLoading(true);
          setOpen(true);
        }}
        style={[styles.btn, { backgroundColor: c.accent }]}
        activeOpacity={0.85}
      >
        <Text style={styles.btnText}>Ask your advisor →</Text>
      </TouchableOpacity>

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: c.background }}>
          <View style={[styles.modalHeader, { borderBottomColor: c.border }]}>
            <Text style={[styles.modalTitle, { color: c.text }]}>Financial Advisor</Text>
            <TouchableOpacity onPress={() => setOpen(false)} hitSlop={12}>
              <Text style={[styles.close, { color: c.accent }]}>Done</Text>
            </TouchableOpacity>
          </View>
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <WebView
              ref={webRef}
              source={{ uri: ADVISOR_URL }}
              onLoadEnd={() => {
                setLoading(false);
                // Re-run after every navigation (e.g. after the login page).
                webRef.current?.injectJavaScript(FOCUS_ADVISOR);
              }}
              injectedJavaScript={FOCUS_ADVISOR}
              sharedCookiesEnabled
              thirdPartyCookiesEnabled
              domStorageEnabled
              originWhitelist={['*']}
              style={{ flex: 1, backgroundColor: c.background }}
            />
            {loading && (
              <View style={[styles.loading, { backgroundColor: c.background }]}>
                <ActivityIndicator color={c.accent} />
                <Text style={[styles.loadingText, { color: c.subtext }]}>Loading your advisor…</Text>
              </View>
            )}
          </KeyboardAvoidingView>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, borderWidth: 1, padding: spacing.md, marginBottom: spacing.md },
  blurb: { fontSize: 13, lineHeight: 19, marginBottom: spacing.md },
  btn: {
    borderRadius: radius.md,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center',
  },
  btnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
  },
  modalTitle: { fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },
  close: { fontSize: 16, fontWeight: '600' },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  loadingText: { fontSize: 13 },
});
