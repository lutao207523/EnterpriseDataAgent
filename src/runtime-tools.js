const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

const DATE_QUESTION = /(?:今天|今日|明天|昨天|现在|当前).{0,8}(?:几号|日期|星期几|周几|几月几日)|(?:现在|当前).{0,4}(?:是)?(?:哪一天|几号)|^(?:今天|今日|明天|昨天)(?:呢)?[？?]?$/i;
const TIME_QUESTION = /(?:现在|当前|北京).{0,6}(?:几点|时间)|(?:几点了|现在几点)[？?]?$/i;

function partsFor(date, timeZone, includeTime = false) {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'long',
    ...(includeTime ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' } : {}),
  });
  return Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
}

function relativeDay(question) {
  if (/明天/.test(question)) return { label: '明天', offset: 1 };
  if (/昨天/.test(question)) return { label: '昨天', offset: -1 };
  return { label: '今天', offset: 0 };
}

export const currentDateTimeTool = {
  name: 'get_current_datetime',
  description: '获取当前日期、星期和北京时间，不依赖大模型知识。',

  canHandle(question) {
    const text = String(question || '').trim();
    return DATE_QUESTION.test(text) || TIME_QUESTION.test(text);
  },

  execute({ question, now = new Date(), timeZone = DEFAULT_TIME_ZONE } = {}) {
    const text = String(question || '').trim();
    if (!this.canHandle(text)) return null;

    if (TIME_QUESTION.test(text)) {
      const parts = partsFor(now, timeZone, true);
      return `现在是${parts.year}年${parts.month}月${parts.day}日，${parts.weekday} ${parts.hour}:${parts.minute}:${parts.second}（北京时间）。`;
    }

    const relative = relativeDay(text);
    const target = new Date(now.getTime() + relative.offset * 24 * 60 * 60 * 1000);
    const parts = partsFor(target, timeZone);
    return `${relative.label}是${parts.year}年${parts.month}月${parts.day}日，${parts.weekday}（北京时间）。`;
  },
};

export function answerRuntimeQuestion(question, options = {}) {
  const text = currentDateTimeTool.execute({ question, ...options });
  return text ? { text, source: `tool:${currentDateTimeTool.name}` } : null;
}
