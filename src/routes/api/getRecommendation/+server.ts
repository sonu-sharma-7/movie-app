import { createParser } from 'eventsource-parser';
import { OPENAI_API_KEY } from '$env/static/private';
import { neon } from '@neondatabase/serverless';

const key = OPENAI_API_KEY;

// Initialize Neon with your database connection string
const sql = neon('postgresql://neondb_owner:KJZyOumgcx96@ep-little-glade-a41n60el.us-east-1.aws.neon.tech/neondb?sslmode=require');


// Object to store the number of requests made by each user and their last request timestamp
interface UserRequestData {
    count: number;
    lastResetTime: number;
}

// Fetch user request data from Neon PostgreSQL
async function getUserRequestData(userIP: string): Promise<UserRequestData | null> {
    try {
        const result = await sql`SELECT count, last_reset_time FROM user_requests WHERE user_ip = ${userIP}`;
        if (result.length === 0) {
            return null; // No data for this user
        }
        const { count, last_reset_time } = result[0];
        return { count, lastResetTime: new Date(last_reset_time).getTime() };
    } catch (error) {
        console.error('Error retrieving user request data:', error);
        throw error;
    }
}

// Update or insert user request data into Neon PostgreSQL
async function updateUserRequestData(userIP: string, data: UserRequestData) {
    try {
        await sql`
            INSERT INTO user_requests (user_ip, count, last_reset_time)
            VALUES (${userIP}, ${data.count}, to_timestamp(${data.lastResetTime / 1000.0}))
            ON CONFLICT (user_ip)
            DO UPDATE SET count = ${data.count}, last_reset_time = to_timestamp(${data.lastResetTime / 1000.0})
        `;
    } catch (error) {
        console.error('Error updating user request data:', error);
        throw error;
    }
}

// Middleware function to enforce rate limits
async function rateLimitMiddleware(request: Request) {
    const userIP =
        request.headers.get('x-forwarded-for') || request.headers.get('cf-connecting-ip') || '';

    const userRequests = await getUserRequestData(userIP);

    if (userRequests) {
        const { count, lastResetTime } = userRequests;
        const currentTime = Date.now();

        const currentDay = new Date(currentTime).toLocaleDateString();
        const lastResetDay = new Date(lastResetTime).toLocaleDateString();
        if (currentDay !== lastResetDay) {
            userRequests.count = 1;
            userRequests.lastResetTime = currentTime;
            await updateUserRequestData(userIP, userRequests);
        } else {
            if (count >= 5) {
                return new Response('Rate limit exceeded, come back tomorrow!', { status: 429 });
            }
            userRequests.count++;
            await updateUserRequestData(userIP, userRequests);
        }
    } else {
        const newUserRequests: UserRequestData = {
            count: 1,
            lastResetTime: Date.now()
        };
        await updateUserRequestData(userIP, newUserRequests);
    }

    return null;
}

interface ChatGPTMessage {
    role: 'user';
    content: string;
}

interface OpenAIStreamPayload {
    model: string;
    messages: ChatGPTMessage[];
    temperature: number;
    top_p: number;
    frequency_penalty: number;
    presence_penalty: number;
    max_tokens: number;
    stream: boolean;
    n: number;
}

async function OpenAIStream(payload: OpenAIStreamPayload) {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`
        },
        method: 'POST',
        body: JSON.stringify(payload)
    });

    const readableStream = new ReadableStream({
        async start(controller) {
            const onParse = (event: any) => {
                if (event.type === 'event') {
                    const data = event.data;
                    controller.enqueue(encoder.encode(data));
                }
            };
            if (res.status !== 200) {
                const data = {
                    status: res.status,
                    statusText: res.statusText,
                    body: await res.text()
                };
                console.log(`Error: received non-200 status code, ${JSON.stringify(data)}`);
                controller.close();
                return;
            }

            const parser = createParser(onParse);
            for await (const chunk of res.body as any) {
                parser.feed(decoder.decode(chunk));
            }
        }
    });
    let counter = 0;
    const transformStream = new TransformStream({
        async transform(chunk, controller) {
            const data = decoder.decode(chunk);
            if (data === '[DONE]') {
                controller.terminate();
                return;
            }
            try {
                const json = JSON.parse(data);
                const text = json.choices[0].delta?.content || '';
                if (counter < 2 && (text.match(/\n/) || []).length) {
                    return;
                }
                const encodedText = encoder.encode(text);
                controller.enqueue(encodedText);
                counter++;
            } catch (e) {
                controller.error(e);
            }
        }
    });
    return readableStream.pipeThrough(transformStream);
}

export async function POST({ request }: { request: any }) {
    const rateLimitResult = await rateLimitMiddleware(request);
    if (rateLimitResult) {
        return rateLimitResult;
    }

    const { searched }: { searched: string } = await request.json();

    const payload: OpenAIStreamPayload = {
        model: 'gpt-3.5-turbo',
        messages: [
            {
                role: 'user',
                content: searched
            }
        ],
        temperature: 0.7,
        max_tokens: 2048,
        top_p: 1.0,
        frequency_penalty: 0.0,
        stream: true,
        presence_penalty: 0.0,
        n: 1
    };

    const stream = await OpenAIStream(payload);

    return new Response(stream);
}
