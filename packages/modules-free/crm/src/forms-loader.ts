/**
 * The embed script.
 *
 * One tag on somebody's website:
 *
 *   <script src="https://their-instance/embed.js"
 *           data-sentrello-form="abc123"></script>
 *
 * It renders the form where the tag sits, posts it, and shows the result —
 * without the site owner writing any HTML. The previous embed handed them a
 * `<form>` to paste, which meant every change to a field was a change to their
 * website, and every site drifted out of step with the form it was showing.
 *
 * Served as a string rather than a built asset because it must run on any
 * site, in any bundler or none, with no framework and no imports. It is small
 * enough to read in one sitting, which is the point: anyone can check what
 * they are pasting onto their own page.
 */

/**
 * Everything a caller sends is escaped before it reaches innerHTML.
 *
 * A form's labels are written by the business, but the definition travels
 * through the browser of whoever is filling it in — and the script runs on the
 * customer's own site, where an injection would be theirs to explain, not
 * ours.
 */
const SCRIPT = String.raw`(function () {
  var tag = document.currentScript;
  if (!tag) return;
  var key = tag.getAttribute("data-sentrello-form");
  if (!key) return;
  var base = new URL(tag.src, window.location.href).origin;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var host = document.createElement("div");
  host.className = "sentrello-form";
  tag.parentNode.insertBefore(host, tag.nextSibling);

  fetch(base + "/api/embed/forms/" + encodeURIComponent(key), {
    credentials: "omit",
  })
    .then(function (r) {
      if (!r.ok) throw new Error("form unavailable");
      return r.json();
    })
    .then(function (form) {
      var style = form.style || {};
      var accent = /^#[0-9a-fA-F]{3,8}$/.test(style.accent || "")
        ? style.accent
        : "#0f766e";
      var radius = /^[0-9.]+(px|rem|em)$/.test(style.radius || "")
        ? style.radius
        : "6px";

      var css = document.createElement("style");
      css.textContent =
        ".sentrello-form{font:inherit;max-width:32rem}" +
        ".sentrello-form label{display:block;margin:.6rem 0 .2rem;font-size:.875rem}" +
        ".sentrello-form input,.sentrello-form textarea,.sentrello-form select{width:100%;padding:.5rem;" +
        "border:1px solid #cbd5e1;border-radius:" + radius + ";font:inherit;box-sizing:border-box}" +
        ".sentrello-form button{margin-top:.8rem;padding:.55rem 1.1rem;border:0;cursor:pointer;" +
        "border-radius:" + radius + ";background:" + accent + ";color:#fff;font:inherit}" +
        ".sentrello-form .sentrello-msg{margin-top:.6rem;font-size:.9rem}" +
        ".sentrello-hp{position:absolute!important;left:-9999px!important}";
      host.appendChild(css);

      var html = "<form novalidate>";
      (form.fields || []).forEach(function (f) {
        var id = "sf-" + key + "-" + esc(f.name);
        // "date" is a native input type, so the visitor gets their own phone's
        // date picker rather than a script we would have to ship and keep
        // accessible. "select" is the one field that is not an input at all.
        var type = ["email", "tel", "number", "url", "date", "textarea", "select"].indexOf(f.type) >= 0 ? f.type : "text";
        var control;
        if (type === "textarea") {
          control = '<textarea id="' + id + '" name="' + esc(f.name) + '" rows="4"' + (f.required ? " required" : "") + "></textarea>";
        } else if (type === "select") {
          // A blank first option, and it carries the "required" refusal: a
          // dropdown that starts on a real answer is one the visitor submits
          // without reading, and the first option is never the honest default.
          var options = '<option value="">' + (f.required ? "Choose one" : "\u2014") + "</option>";
          (f.options || []).forEach(function (o) {
            options += "<option>" + esc(o) + "</option>";
          });
          control = '<select id="' + id + '" name="' + esc(f.name) + '"' + (f.required ? " required" : "") + ">" + options + "</select>";
        } else {
          control = '<input id="' + id + '" type="' + type + '" name="' + esc(f.name) + '"' + (f.required ? " required" : "") + ">";
        }
        html +=
          '<label for="' + id + '">' + esc(f.label || f.name) +
          (f.required ? " *" : "") + "</label>" + control;
      });
      // The honeypot the server already checks. Hidden off-screen rather than
      // display:none, which some bots know to skip.
      html +=
        '<input class="sentrello-hp" tabindex="-1" autocomplete="off" name="' +
        esc(form.honeypot) + '">' +
        "<button type=submit>Send</button>" +
        '<div class="sentrello-msg" role="status"></div></form>';
      host.insertAdjacentHTML("beforeend", html);

      var el = host.querySelector("form");
      var msg = host.querySelector(".sentrello-msg");
      el.addEventListener("submit", function (e) {
        e.preventDefault();
        var button = el.querySelector("button");
        button.disabled = true;
        msg.textContent = "Sending…";

        fetch(base + "/api/embed/forms/" + encodeURIComponent(key), {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "omit",
          body: JSON.stringify(
            Array.prototype.reduce.call(
              new FormData(el).entries(),
              function (acc, pair) { acc[pair[0]] = pair[1]; return acc; },
              {},
            ),
          ),
        })
          .then(function (r) {
            if (!r.ok) throw new Error("failed");
            return r.json().catch(function () { return {}; });
          })
          .then(function (out) {
            if (form.redirectUrl) {
              window.location.href = form.redirectUrl;
              return;
            }
            // Replaced rather than cleared: a form that empties itself looks
            // like it lost what was typed.
            host.innerHTML = "";
            host.appendChild(css);
            var done = document.createElement("p");
            done.className = "sentrello-msg";
            done.textContent = out.message || "Thanks — we have your message.";
            host.appendChild(done);
          })
          .catch(function () {
            button.disabled = false;
            msg.textContent = "That did not send. Please try again.";
          });
      });
    })
    .catch(function () {
      // Silent on the page. A site owner whose allow-list is wrong should not
      // have an error printed to their visitors; the console is where they
      // will look.
      if (window.console) console.warn("[sentrello] form " + key + " unavailable");
    });
})();`;

export function embedScript(): string {
  return SCRIPT;
}
