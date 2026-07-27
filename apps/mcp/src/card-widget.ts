export const CREATORCUT_CARD_WIDGET_URI =
  "ui://creatorcut/decision-cards-v1.html";
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

export const CREATORCUT_CARD_WIDGET_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; connect-src 'none'; img-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"
    />
    <title>CreatorCut 制作决策</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family:
          Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
          "Segoe UI", sans-serif;
        --surface: light-dark(#ffffff, #171717);
        --surface-soft: light-dark(#f6f7f9, #222222);
        --border: light-dark(#dedfe3, #3a3a3a);
        --text: light-dark(#171717, #f4f4f4);
        --muted: light-dark(#62666d, #b2b2b2);
        --accent: light-dark(#1668dc, #6ea8ff);
        --accent-soft: light-dark(#edf5ff, #182b47);
        --danger: light-dark(#b42318, #ff8b82);
        --success: light-dark(#087443, #57d69a);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        padding: 14px;
        background: transparent;
        color: var(--text);
      }

      main {
        max-width: 760px;
        margin: 0 auto;
      }

      header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 14px;
      }

      h1 {
        margin: 0;
        font-size: 18px;
        line-height: 1.3;
      }

      #stage {
        flex: none;
        padding: 4px 9px;
        border-radius: 999px;
        background: var(--accent-soft);
        color: var(--accent);
        font-size: 12px;
        font-weight: 650;
      }

      #summary {
        margin: 4px 0 0;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.45;
      }

      #cards {
        display: grid;
        gap: 12px;
      }

      fieldset {
        min-width: 0;
        margin: 0;
        padding: 14px;
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--surface);
      }

      legend {
        max-width: 100%;
        padding: 0 5px;
        font-weight: 680;
      }

      .required {
        color: var(--danger);
      }

      .prompt,
      .known,
      .preview {
        margin: 0 0 10px;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.45;
      }

      .known {
        padding: 7px 9px;
        border-radius: 8px;
        background: var(--surface-soft);
      }

      .options {
        display: grid;
        gap: 8px;
      }

      .option {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 9px;
        align-items: flex-start;
        padding: 10px;
        border: 1px solid var(--border);
        border-radius: 9px;
        cursor: pointer;
      }

      .option:has(input:checked) {
        border-color: var(--accent);
        background: var(--accent-soft);
      }

      .option input {
        margin: 3px 0 0;
        accent-color: var(--accent);
      }

      .option-title {
        display: block;
        font-size: 14px;
        font-weight: 620;
      }

      .option-description,
      .preview {
        display: block;
        margin: 3px 0 0;
      }

      textarea {
        width: 100%;
        min-height: 84px;
        resize: vertical;
        padding: 10px;
        border: 1px solid var(--border);
        border-radius: 9px;
        background: var(--surface-soft);
        color: var(--text);
        font: inherit;
      }

      footer {
        position: sticky;
        bottom: 0;
        display: flex;
        align-items: center;
        gap: 12px;
        margin-top: 14px;
        padding: 12px 0 2px;
        background: var(--surface);
      }

      button {
        flex: none;
        min-height: 38px;
        padding: 0 16px;
        border: 0;
        border-radius: 9px;
        background: var(--accent);
        color: #ffffff;
        font: inherit;
        font-weight: 680;
        cursor: pointer;
      }

      button:disabled {
        cursor: wait;
        opacity: 0.58;
      }

      #status {
        min-width: 0;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.4;
      }

      #status[data-kind="error"] {
        color: var(--danger);
      }

      #status[data-kind="success"] {
        color: var(--success);
      }

      #empty {
        padding: 18px;
        border: 1px dashed var(--border);
        border-radius: 12px;
        color: var(--muted);
        text-align: center;
      }

      @media (max-width: 520px) {
        body {
          padding: 10px;
        }

        header {
          display: block;
        }

        #stage {
          display: inline-block;
          margin-top: 8px;
        }

        footer {
          align-items: stretch;
          flex-direction: column;
        }

        button {
          width: 100%;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>CreatorCut 制作决策</h1>
          <p id="summary">等待宿主传入当前签名卡片…</p>
        </div>
        <span id="stage">准备中</span>
      </header>
      <form id="decision-form">
        <div id="cards">
          <div id="empty">正在加载当前决策卡片</div>
        </div>
        <footer>
          <button id="submit" type="submit" disabled>提交这些选择</button>
          <span id="status" role="status" aria-live="polite"></span>
        </footer>
      </form>
    </main>
    <script>
      (() => {
        "use strict";

        const pendingRequests = new Map();
        let nextRequestId = 1;
        let currentPayload;
        const form = document.getElementById("decision-form");
        const cardsRoot = document.getElementById("cards");
        const summary = document.getElementById("summary");
        const stage = document.getElementById("stage");
        const submitButton = document.getElementById("submit");
        const status = document.getElementById("status");

        const stageLabels = {
          direction: "制作方向",
          look_and_sound: "视听风格",
          review: "精剪审阅",
          execution: "执行确认",
        };

        function setStatus(text, kind) {
          status.textContent = text;
          if (kind) status.dataset.kind = kind;
          else delete status.dataset.kind;
        }

        function request(method, params) {
          const id = nextRequestId++;
          window.parent.postMessage(
            { jsonrpc: "2.0", id, method, params },
            "*",
          );
          return new Promise((resolve, reject) => {
            pendingRequests.set(id, { resolve, reject });
          });
        }

        function textElement(tag, className, text) {
          const element = document.createElement(tag);
          if (className) element.className = className;
          element.textContent = String(text ?? "");
          return element;
        }

        function optionControl(card, option, inputType) {
          const label = document.createElement("label");
          label.className = "option";

          const input = document.createElement("input");
          input.type = inputType;
          input.name = card.card_id;
          input.value = option.option_id;
          input.dataset.cardId = card.card_id;
          input.checked = Array.isArray(card.default_option_ids)
            ? card.default_option_ids.includes(option.option_id)
            : false;
          label.append(input);

          const copy = document.createElement("span");
          copy.append(
            textElement("span", "option-title", option.label),
          );
          if (option.description) {
            copy.append(
              textElement(
                "span",
                "option-description",
                option.description,
              ),
            );
          }
          if (option.preview_ref) {
            copy.append(
              textElement(
                "span",
                "preview",
                "本地预览引用：" + option.preview_ref,
              ),
            );
          }
          label.append(copy);
          return label;
        }

        function renderChoiceCard(fieldset, card) {
          const options = document.createElement("div");
          options.className = "options";
          const inputType =
            card.control === "checkbox" ? "checkbox" : "radio";
          for (const option of card.options ?? []) {
            options.append(optionControl(card, option, inputType));
          }
          fieldset.append(options);
        }

        function renderTextCard(fieldset, card) {
          const textarea = document.createElement("textarea");
          textarea.name = card.card_id;
          textarea.dataset.cardId = card.card_id;
          textarea.value = String(card.default_text ?? "");
          textarea.placeholder = String(card.placeholder ?? "");
          if (card.required) textarea.required = true;
          fieldset.append(textarea);
        }

        function renderReviewCard(fieldset, card) {
          const options = document.createElement("div");
          options.className = "options";
          for (const choice of [
            { value: "approve", label: "确认，继续" },
            { value: "reject", label: "暂不确认" },
          ]) {
            const option = {
              option_id: choice.value,
              label: choice.label,
            };
            const label = optionControl(card, option, "radio");
            const input = label.querySelector("input");
            input.checked =
              card.default_approved === (choice.value === "approve");
            options.append(label);
          }
          fieldset.append(options);
        }

        function render(payload) {
          const presentation = payload?.presentation;
          const cards = Array.isArray(presentation?.cards)
            ? presentation.cards
            : [];
          if (!payload || !presentation || cards.length === 0) {
            setStatus("宿主没有提供可用的 CreatorCut 卡片。", "error");
            return;
          }

          currentPayload = payload;
          cardsRoot.replaceChildren();
          stage.textContent =
            stageLabels[presentation.stage] ?? String(presentation.stage);
          summary.textContent =
            "项目版本 " +
            String(presentation.state_revision) +
            " · " +
            String(cards.length) +
            " 项需要确认";

          for (const card of cards) {
            const fieldset = document.createElement("fieldset");
            fieldset.dataset.cardId = String(card.card_id);
            fieldset.dataset.cardType = String(card.type);
            fieldset.dataset.required = card.required ? "true" : "false";
            if (card.min_selections !== undefined) {
              fieldset.dataset.minSelections = String(card.min_selections);
            }
            if (card.max_selections !== undefined) {
              fieldset.dataset.maxSelections = String(card.max_selections);
            }

            const legend = document.createElement("legend");
            legend.textContent = String(card.title);
            if (card.required) {
              legend.append(textElement("span", "required", " *"));
            }
            fieldset.append(legend);
            fieldset.append(textElement("p", "prompt", card.prompt));
            if (card.known_value_source) {
              fieldset.append(
                textElement(
                  "p",
                  "known",
                  "已知信息：" + card.known_value_source,
                ),
              );
            }

            if (card.control === "textarea") {
              renderTextCard(fieldset, card);
            } else if (card.control === "approval") {
              renderReviewCard(fieldset, card);
            } else {
              renderChoiceCard(fieldset, card);
            }
            cardsRoot.append(fieldset);
          }

          submitButton.disabled = false;
          setStatus("请检查预填项，再提交。");
        }

        function selectedInputs(fieldset) {
          return Array.from(
            fieldset.querySelectorAll("input:checked"),
          );
        }

        function collectResponses() {
          const responses = [];
          for (const fieldset of cardsRoot.querySelectorAll("fieldset")) {
            const cardId = fieldset.dataset.cardId;
            const cardType = fieldset.dataset.cardType;
            const required = fieldset.dataset.required === "true";

            if (cardType === "text") {
              const textarea = fieldset.querySelector("textarea");
              const textValue = textarea.value.trim();
              if (required && textValue.length === 0) {
                throw new Error("请填写“" + fieldset.querySelector("legend").textContent.trim() + "”。");
              }
              responses.push({
                card_id: cardId,
                text_value: textValue,
              });
              continue;
            }

            if (cardType === "review") {
              const selected = selectedInputs(fieldset)[0];
              if (!selected && required) {
                throw new Error("请明确确认或拒绝当前方案。");
              }
              responses.push({
                card_id: cardId,
                approved: selected?.value === "approve",
              });
              continue;
            }

            const selected = selectedInputs(fieldset).map(
              (input) => input.value,
            );
            const minimum = Number(
              fieldset.dataset.minSelections ?? (required ? "1" : "0"),
            );
            const maximum = Number(
              fieldset.dataset.maxSelections ?? "999",
            );
            if (selected.length < minimum) {
              throw new Error(
                "“" +
                  fieldset.querySelector("legend").textContent.trim() +
                  "”至少选择 " +
                  String(minimum) +
                  " 项。",
              );
            }
            if (selected.length > maximum) {
              throw new Error(
                "“" +
                  fieldset.querySelector("legend").textContent.trim() +
                  "”最多选择 " +
                  String(maximum) +
                  " 项。",
              );
            }
            responses.push({
              card_id: cardId,
              selected_values: selected,
            });
          }
          return responses;
        }

        function errorMessage(error) {
          if (typeof error?.message === "string") return error.message;
          if (typeof error?.data?.message === "string") {
            return error.data.message;
          }
          return "提交失败，请通过文本回退继续，或重新读取当前卡片。";
        }

        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          if (!currentPayload) return;

          let responses;
          try {
            responses = collectResponses();
          } catch (error) {
            setStatus(errorMessage(error), "error");
            return;
          }

          submitButton.disabled = true;
          setStatus("正在提交当前版本的选择…");
          try {
            const result = await request("tools/call", {
              name: "creatorcut_director_cards_submit",
              arguments: {
                answer_set_id: currentPayload.answer_set_id,
                presentation_id:
                  currentPayload.presentation.presentation_id,
                presentation_digest:
                  currentPayload.presentation_digest,
                responses,
              },
            });
            if (result?.isError) {
              const detail = result.content?.find(
                (item) => item.type === "text",
              )?.text;
              throw new Error(detail || "CreatorCut 拒绝了当前答案。");
            }
            setStatus("选择已保存，可以继续下一步。", "success");
          } catch (error) {
            submitButton.disabled = false;
            setStatus(errorMessage(error), "error");
          }
        });

        window.addEventListener(
          "message",
          (event) => {
            if (event.source !== window.parent) return;
            const message = event.data;
            if (!message || message.jsonrpc !== "2.0") return;

            if (
              message.id !== undefined &&
              pendingRequests.has(message.id)
            ) {
              const pending = pendingRequests.get(message.id);
              pendingRequests.delete(message.id);
              if (message.error) pending.reject(message.error);
              else pending.resolve(message.result);
              return;
            }

            if (message.method === "ui/notifications/tool-result") {
              render(message.params?.structuredContent);
            }
          },
          { passive: true },
        );
      })();
    </script>
  </body>
</html>`;
