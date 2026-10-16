const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { Aki } = require('akinator');

const app = express();
app.use(bodyParser.json());

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// تخزين جلسات الألعاب النشطة لكل مستخدم
const games = {};

// صورة المارد الأزرق عند طرح الأسئلة
const AKINATOR_IMG = 'https://i.imgur.com/8Q9Z5Yw.png';

// 1. التحقق من Webhook الفيسبوك
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.status(200).send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

// 2. استقبال الأحداث والرسائل
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'page') {
    for (const entry of body.entry) {
      if (!entry.messaging || entry.messaging.length === 0) continue;
      const webhookEvent = entry.messaging[0];
      const senderPsid = webhookEvent.sender.id;

      // أ) الضغط على زر Postback (مثل زر "ابدأ اللعبة")
      if (webhookEvent.postback) {
        const payload = webhookEvent.postback.payload;
        if (payload === 'START_GAME') {
          await startGame(senderPsid);
        }
      }
      // ب) ضغط زر إجابة Quick Reply أو إرسال نص
      else if (webhookEvent.message) {
        const message = webhookEvent.message;

        if (message.quick_reply) {
          const payload = message.quick_reply.payload;
          if (payload === 'START_GAME') {
            await startGame(senderPsid);
          } else {
            await handleAnswer(senderPsid, payload);
          }
        } else if (message.text) {
          const text = message.text.toLowerCase().trim();
          if (text.includes('ابدأ') || text.includes('لعب') || text.includes('start')) {
            await startGame(senderPsid);
          } else {
            await sendWelcomeCard(senderPsid);
          }
        }
      }
    }
    res.status(200).send('EVENT_RECEIVED');
  } else {
    res.sendStatus(404);
  }
});

// بدء لعبة جديدة
async function startGame(senderPsid) {
  try {
    const aki = new Aki({ region: 'ar' }); // اللغة العربية
    await aki.start();
    games[senderPsid] = aki;

    await sendQuestionCard(senderPsid, aki.question, aki.currentStep + 1);
  } catch (error) {
    console.error('Error starting Akinator:', error);
    await sendTextMessage(senderPsid, '❌ حدث خطأ أثناء الاتصال بالمارد الأزرق. يرجى المحاولة لاحقاً!');
  }
}

// معالجة إجابة اللاعب
async function handleAnswer(senderPsid, answerId) {
  const aki = games[senderPsid];

  if (!aki) {
    return await startGame(senderPsid);
  }

  try {
    // إرسال الإجابة للمارد (0=نعم, 1=لا, 2=لا أعلم, 3=الظاهر ذلك, 4=على الأغلب لا)
    await aki.step(parseInt(answerId));

    // إذا اكتشف المارد الشخصية بنسبة عالية أو انتهت الأسئلة
    if (aki.progress >= 85 || aki.currentStep >= 75) {
      await aki.win();
      const guess = aki.answers[0];

      if (guess) {
        await sendFinalGuessCard(senderPsid, guess);
      } else {
        await sendTextMessage(senderPsid, '🔮 لم أستطع تخمين الشخصية هذه المرة! كسبت التحدي.');
      }
      delete games[senderPsid]; // إنهاء الجلسة
    } else {
      // إرسال السؤال التالي
      await sendQuestionCard(senderPsid, aki.question, aki.currentStep + 1);
    }
  } catch (error) {
    console.error('Error handling answer:', error);
    await sendTextMessage(senderPsid, '⚠️ حدث خطأ أثناء معالجة الإجابة، سنبدأ لعبة جديدة!');
    delete games[senderPsid];
  }
}

// إرسال بطاقة السؤال مع الأزرار الخمسة احترافية
async function sendQuestionCard(senderPsid, questionText, stepNumber) {
  const payload = {
    recipient: { id: senderPsid },
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'generic',
          elements: [
            {
              title: `السؤال رقم ${stepNumber} 🔮`,
              subtitle: questionText,
              image_url: AKINATOR_IMG
            }
          ]
        }
      },
      // الأزرار التفاعلية الـ 5 كـ Quick Replies تظهر أسفل البطاقة
      quick_replies: [
        { content_type: 'text', title: '🟢 نعم', payload: '0' },
        { content_type: 'text', title: '🔴 لا', payload: '1' },
        { content_type: 'text', title: '🟡 لا أعلم', payload: '2' },
        { content_type: 'text', title: '🔵 الظاهر ذلك', payload: '3' },
        { content_type: 'text', title: '🟣 على الأغلب لا', payload: '4' }
      ]
    }
  };

  await callFacebookAPI(payload);
}

// إرسال بطاقة النتيجة النهائية (صورة الشخصية + الاسم + الوصف)
async function sendFinalGuessCard(senderPsid, guess) {
  const payload = {
    recipient: { id: senderPsid },
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'generic',
          elements: [
            {
              title: `🎉 أنا أفكر في: ${guess.name}`,
              subtitle: guess.description ? `الوصف: ${guess.description}` : 'أنا أقرأ أفكارك دائماً!',
              image_url: guess.absolute_picture_path || AKINATOR_IMG,
              buttons: [
                {
                  type: 'postback',
                  title: '🎮 التحدي مرة أخرى',
                  payload: 'START_GAME'
                }
              ]
            }
          ]
        }
      }
    }
  };

  await callFacebookAPI(payload);
}

// رسالة الترحيب عند بدء المحادثة
async function sendWelcomeCard(senderPsid) {
  const payload = {
    recipient: { id: senderPsid },
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'button',
          text: 'أهلاً بك في لعبة المارد الأزرق! 🧞‍♂️\nفكر في شخصية (حقيقية أو خيالية) وسأقوم بتخمينها عبر بضعة أسئلة!',
          buttons: [
            {
              type: 'postback',
              title: '🚀 ابدأ اللعبة الآن',
              payload: 'START_GAME'
            }
          ]
        }
      }
    }
  };

  await callFacebookAPI(payload);
}

// إرسال نص عادي
async function sendTextMessage(senderPsid, text) {
  await callFacebookAPI({
    recipient: { id: senderPsid },
    message: { text }
  });
}

// دالة التواصل مع فيسبوك Graph API
async function callFacebookAPI(requestBody) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_ACCESS_TOKEN}`,
      requestBody
    );
  } catch (error) {
    console.error('Facebook API Error:', error.response ? error.response.data : error.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Akinator Messenger Bot running on port ${PORT}`));
