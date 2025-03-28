import { BaseLLM } from "..";
import {
  ChatMessage,
  CompletionOptions,
  LLMOptions,
  ModelProvider,
} from "../..";
import { stripImages } from "../countTokens";
import { streamSse } from "../stream";

const NON_CHAT_MODELS = [
  "text-davinci-002",
  "text-davinci-003",
  "code-davinci-002",
  "text-ada-001",
  "text-babbage-001",
  "text-curie-001",
  "davinci",
  "curie",
  "babbage",
  "ada",
];

const CHAT_ONLY_MODELS = [
  "gpt-3.5-turbo",
  "gpt-3.5-turbo-0613",
  "gpt-3.5-turbo-16k",
  "gpt-4",
  "gpt-35-turbo-16k",
  "gpt-35-turbo-0613",
  "gpt-35-turbo",
  "gpt-4-32k",
  "gpt-4-turbo-preview",
  "gpt-4-vision",
  "gpt-4-0125-preview",
  "gpt-4-1106-preview",
];

class OpenAI extends BaseLLM {
  public useLegacyCompletionsEndpoint = false;

  static providerName: ModelProvider = "openai";
  static defaultOptions: Partial<LLMOptions> = {
    apiBase: "https://api.openai.com/v1/",
  };

  protected _convertMessage(message: ChatMessage) {
    if (typeof message.content === "string") {
      return message;
    }

    const parts = message.content.map((part) => {
      return {
        type: part.type,
        text: part.text,
        image_url: { ...part.imageUrl, detail: "low" },
      };
    });
    return {
      ...message,
      content: parts,
    };
  }

  protected _convertArgs(options: any, messages: ChatMessage[]) {
    const finalOptions = {
      messages: messages.map(this._convertMessage),
      model: options.model,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      top_p: options.topP,
      frequency_penalty: options.frequencyPenalty,
      presence_penalty: options.presencePenalty,
      // Jan doesn't truncate and will throw an error
      stop: this.apiBase?.includes(":1337")
        ? options.stop?.slice(0, 4)
        : options.stop,
    };

    return finalOptions;
  }

  protected async _complete(
    prompt: string,
    options: CompletionOptions,
  ): Promise<string> {
    let completion = "";
    for await (const chunk of this._streamChat(
      [{ role: "user", content: prompt }],
      options,
    )) {
      completion += chunk.content;
    }

    return completion;
  }

  private _getEndpoint(
    endpoint: "chat/completions" | "completions" | "models",
  ) {
    if (this.apiType === "azure") {
      return new URL(
        `openai/deployments/${this.engine}/${endpoint}?api-version=${this.apiVersion}`,
        this.apiBase,
      );
    } else {
      if (!this.apiBase) {
        throw new Error(
          "No API base URL provided. Please set the 'apiBase' option in config.json",
        );
      }

      return new URL(endpoint, this.apiBase);
    }
  }

  protected async *_streamComplete(
    prompt: string,
    options: CompletionOptions,
  ): AsyncGenerator<string> {
    for await (const chunk of this._streamChat(
      [{ role: "user", content: prompt }],
      options,
    )) {
      yield stripImages(chunk.content);
    }
  }

  protected async *_legacystreamComplete(
    prompt: string,
    options: CompletionOptions,
  ): AsyncGenerator<string> {
    const args: any = this._convertArgs(options, []);
    args.prompt = prompt;
    delete args.messages;

    const response = await this.fetch(this._getEndpoint("completions"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "api-key": this.apiKey ?? "", // For Azure
      },
      body: JSON.stringify({
        ...args,
        stream: true,
      }),
    });

    for await (const value of streamSse(response)) {
      if (value.choices?.[0]?.text && value.finish_reason !== "eos") {
        yield value.choices[0].text;
      }
    }
  }

  protected async *_streamChat(
    messages: ChatMessage[],
    options: CompletionOptions,
  ): AsyncGenerator<ChatMessage> {
    if (
      !CHAT_ONLY_MODELS.includes(options.model) &&
      (NON_CHAT_MODELS.includes(options.model) ||
        this.useLegacyCompletionsEndpoint)
    ) {
      for await (const content of this._legacystreamComplete(
        stripImages(messages[messages.length - 1]?.content || ""),
        options,
      )) {
        yield {
          role: "assistant",
          content,
        };
      }
      return;
    }

    let body = {
      ...this._convertArgs(options, messages),
      stream: true,
    };
    // Empty messages cause an error in LM Studio
    body.messages = body.messages.map((m) => ({
      ...m,
      content: m.content === "" ? " " : m.content,
    })) as any;
    const response = await this.fetch(this._getEndpoint("chat/completions"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "api-key": this.apiKey ?? "", // For Azure
      },
      body: JSON.stringify(body),
    });

    for await (const value of streamSse(response)) {
      if (value.choices?.[0]?.delta?.content) {
        yield value.choices[0].delta;
      }
    }
  }

  async listModels(): Promise<string[]> {
    const response = await this.fetch(this._getEndpoint("models"), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "api-key": this.apiKey ?? "", // For Azure
      },
    });

    const data = await response.json();
    return data.data.map((m: any) => m.id);
  }
}

export default OpenAI;
